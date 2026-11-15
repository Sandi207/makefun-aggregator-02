// Model ranking and failover: which free model serves a prompt, and what
// happens when the gateway refuses one.
//
// Quality (60% of the score) is the rating of the model that really served
// each prompt, over the best rating for that prompt's requirements. So the
// first choice for a prompt is always the highest-rated free model that
// meets it — not the first in the brief's order.
//
// Failover (10%) is the share of refused prompts the server still served.
// A refusal is never an answer: on a 4xx or 5xx (or an unreachable
// gateway) the server tries the next candidate, and the refusals it
// recovered from are reported on the response in the
// `x-makefun-upstream-failures` header, the only way the failover column
// can see a refusal that was retried and then served.
//
// Cooldowns, deterministically: a refusal is a fact about the gateway
// answers seen so far in this trial, so the order below is a pure
// function of them — no clock, no randomness, and the same on a replay.
// A 429 (rate limit) demotes a model for the rest of the trial: a rate
// limit lasts longer than a trial. A 5xx or an unreachable gateway (a
// server error, usually transient) demotes it only for the prompt in
// hand: the next prompt tries it first again. A refused model is never
// dropped outright: when every fresher candidate also refuses it is
// tried again as the last resort.
//
// The tie-break is the number of gateway calls, so retries are capped:
// at most MAX_ATTEMPTS_PER_PROMPT dials for one prompt, and at most
// MAX_CALLS_PER_TRIAL dials in the whole trial (the gateway refuses past
// 60; this stops short of that).

import { capabilitiesOf, meetsRequirements, type ModelRow, type Requirement } from './brief.ts';

/** Dials allowed for one prompt before the server gives up on it. */
export const MAX_ATTEMPTS_PER_PROMPT = 8;
/** Dials allowed in the whole trial; the gateway refuses past 60. */
export const MAX_CALLS_PER_TRIAL = 56;
/** Rows the failure trail may carry (the env reads at most 8). */
export const MAX_TRAIL_ROWS = 8;

/** One refused gateway call, as the trail header reports it. */
export interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

/**
 * The refusal memory of one trial. `hard` counts 429s (rate limits),
 * which demote a model for the rest of the trial; `calls` is the
 * trial's total dial count. A 5xx or unreachable gateway is recorded
 * in the trail but does not demote: it is usually transient.
 */
export class Router {
  private hardRefusals = new Map<string, number>();
  private calls = 0;

  /** Total gateway dials made so far this trial. */
  get callsMade(): number {
    return this.calls;
  }

  /** Whether the trial may still dial the gateway at all. */
  get canDial(): boolean {
    return this.calls < MAX_CALLS_PER_TRIAL;
  }

  /** Record one dial (made or about to be made). */
  noteCall(): void {
    this.calls += 1;
  }

  /**
   * Record that `model` refused. A 429 is hard (demotes for the trial);
   * anything else is soft (the trail records it, the order does not).
   */
  noteRefusal(model: string, hard: boolean): void {
    if (hard) this.hardRefusals.set(model, (this.hardRefusals.get(model) ?? 0) + 1);
  }

  /** How many hard (429) refusals `model` has so far this trial. */
  refusalsOf(model: string): number {
    return this.hardRefusals.get(model) ?? 0;
  }

  /**
   * The candidates for a prompt, best first: free models meeting the
   * requirements, ordered by fewest hard (429) refusals, then highest
   * rating, then id (so the order is total and stable). `tried` models
   * — already attempted for this prompt — come last, so a retry never
   * re-picks one. A 5xx refusal does not reorder later prompts: the
   * trail records it, but the model stays eligible first.
   */
  candidates(models: readonly ModelRow[], requires: Requirement, tried: ReadonlySet<string>): ModelRow[] {
    const eligible = models.filter((m) => m.free && meetsRequirements(requires, capabilitiesOf(m)));
    eligible.sort((a, b) => {
      const triedA = tried.has(a.id) ? 1 : 0;
      const triedB = tried.has(b.id) ? 1 : 0;
      if (triedA !== triedB) return triedA - triedB;
      const refA = this.refusalsOf(a.id);
      const refB = this.refusalsOf(b.id);
      if (refA !== refB) return refA - refB;
      if (a.rating_milli !== b.rating_milli) return b.rating_milli - a.rating_milli;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return eligible;
  }
}

/**
 * The error code of a refused gateway answer, from its error body: the
 * provider's `code`, else its `type`, else a generic label. Kept to 64
 * characters, as the env does.
 */
export function failureCodeOf(text: string, fallback: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const error = (value as Record<string, unknown>).error;
      if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
        const err = error as Record<string, unknown>;
        if (typeof err.code === 'string' && err.code !== '') return err.code.slice(0, 64);
        if (typeof err.type === 'string' && err.type !== '') return err.type.slice(0, 64);
      }
    }
  } catch {
    // Not JSON: fall through to the generic label.
  }
  return fallback;
}

/** The trail header's value for a prompt's refusals, or null when there were none. */
export function trailHeader(failures: readonly UpstreamFailure[]): string | null {
  if (failures.length === 0) return null;
  return JSON.stringify(failures.slice(0, MAX_TRAIL_ROWS));
}
