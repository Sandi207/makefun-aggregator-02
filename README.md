# Live free-model aggregator

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/Sandi207/makefun-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/Sandi207/makefun-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server that makes OpenRouter's free models a single endpoint: a client
points at it, and every completion it answers comes from a real free model
dialled through the grader's gateway. Entry for the make.fun bounty
**free-model-aggregator-02** ("The best live free-model aggregator").

## What it serves

- `POST /v1/chat/completions` — OpenAI-compatible, JSON and streaming
  (server-sent events).
- `POST /v1/messages` — Anthropic-compatible, JSON and streaming, translated
  to Chat Completions upstream and back.
- `GET /v1/models` — the model list, in the wire its auth header names:
  an `Authorization: Bearer` request gets the OpenAI list, an `x-api-key`
  request the Anthropic one.

Run it with `node main.ts`. `node main.ts --list` prints the catalog and
exits 0. Node 22 standard library only — nothing is installed.

## Routing: best model first

Quality is 60% of the score, so the first choice for a prompt is the
highest-rated free model that meets what the request asks for — read off
the request body itself, not the brief's manifest order:

| Prompt needs | First pick (rating) |
|---|---|
| JSON mode | NVIDIA Nemotron 3.5 Super VL — 1303 (best JSON-capable) |
| Tools | Thinking Machines Inkling 2 Small — 1475 (best tools-capable) |
| Anything else | Thinking Machines Inkling 2 Small — 1475 (best overall) |

The fourteen free models, their ratings and capabilities come from the
trial brief at `$MAKEFUN_PROMPT_FILE`; the server never hard-codes a model
id for routing, only the brief's list.

## Failover and cooldowns

A refusal is never an answer. On a 4xx or 5xx from the gateway (or an
unreachable gateway) the server tries the next candidate that meets the
request, and reports the refusals it recovered from on the response in the
`x-makefun-upstream-failures` header — the only way the failover column
can see a refusal that was retried and then served.

A 429 (rate limit) demotes a model for the rest of the trial: a rate
limit lasts longer than a trial, and retrying it would waste the
tie-break dials. A 5xx or an unreachable gateway demotes it only for
the prompt in hand: server errors are usually transient, so the next
prompt tries it first again. A refused model is never dropped
outright: when every fresher candidate also refuses it is tried again
as the last resort. The order is a pure function of the brief, the
request and the gateway answers seen so far — no clock, no randomness
— so a replay makes the same choices.

Retries are capped (8 per prompt, 56 per trial: the gateway refuses past
60, and the tie-break is the call count).

## The catalog

The catalog is one provider, `openrouter`, with exactly the fourteen free
models the brief lists, each as its dialable id
(`openrouter/<vendor>/<model>:free`). `node main.ts --list` prints the
same document the register body carries, byte for byte. `GET /v1/models`
answers with exactly that set on both auth headers.

## Wire fidelity

- Every response's `model` field names the model actually dialled (the
  provider's own answer spells it without the gateway's `openrouter/`
  prefix; this server puts the dialled id back on every answer and every
  streamed chunk).
- OpenAI streaming relays the upstream SSE frames in order, ending with
  `[DONE]`; usage rides on the final chunk (`stream_options.include_usage`
  is set on every streamed upstream call).
- Anthropic streaming emits `message_start`, `content_block_start`,
  `content_block_delta`, `content_block_stop`, `message_delta`,
  `message_stop` in order; tool calls become `tool_use` blocks and
  `input_json_delta` events.
- System prompts, `max_tokens`, temperature, `top_p`, stop sequences,
  tools and tool choice all pass through; an Anthropic request's system
  prompt becomes a system message, image blocks become `image_url` data
  URLs, `tool_result` blocks become tool messages.
- The gateway requires an output cap, so a request that names none gets
  `max_tokens: 1024` (never over the 8192 cap).

## Layout

- `main.ts` — the server: the brief, the catalog, the routes, the
  register and the work poll.
- `lib/brief.ts` — the brief's types and parser, the free model list,
  the catalog.
- `lib/route.ts` — model ranking, refusal memory, the failure trail.
- `lib/wire.ts` — Anthropic ↔ Chat Completions translation, the model
  field, the SSE writers.
- `.makefun/owner.json` — the claim file naming the entry's wallet.
