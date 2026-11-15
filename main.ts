// free-model-aggregator-02: one server, two client wires, and a real free
// model behind every answer.
//
// The client points at this server, and every completion it answers comes
// from a real free model dialled through the grader's gateway on the
// trial's key — never an answer of this server's own.
//
// WHAT A TRIAL GIVES THIS SERVER
//   The env is at $MAKEFUN_ENV_URL; model calls go through the grader's
//   gateway at $OPENAI_BASE_URL, an OpenAI-compatible endpoint that reaches
//   OpenRouter on the key pushed to the competition. The brief at
//   $MAKEFUN_PROMPT_FILE carries two documents:
//     - the free model list: each free OpenRouter model's gateway id
//       (`openrouter/<vendor>/<model>:free`), its published rating in
//       milli-points, what it can do (tools, vision, JSON mode, context
//       length) and its free flag;
//     - the six prompts: each one's id, its api (openai or anthropic),
//       whether it streams, its weight (1 or 2) and the requirements a
//       model must meet to serve it. Each prompt carries a unique token
//       the answer must contain.
//   The server:
//     1. listens on 0.0.0.0 at a free port (never 8080: the env itself is there on one layout);
//     2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port": <port>, "catalog": <catalog>};
//     3. serves GET /v1/models (answering in the shape of the auth header it got: x-api-key means
//        Anthropic, Authorization means OpenAI), POST /v1/chat/completions and POST /v1/messages, each
//        with a JSON body or with server-sent events;
//     4. answers each prompt by dialling ONE free model through the gateway. OPENAI_API_KEY in the
//        sandbox is a dummy the gateway swaps for the OpenRouter key pushed to the competition; the
//        real key never enters the sandbox;
//     5. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the env says {"done": true}. A
//        process still running when the wall ends scores zero, so never wait for anything else.
//   `node main.ts --list` prints the same catalog JSON and exits 0 before any server starts; the
//   register body's catalog is that same document, byte for byte.
//
// ROUTING (quality is 60% of the score)
//   The first choice for a prompt is the highest-rated free model that
//   meets the request's requirements, read off the request body itself:
//   a JSON-mode `response_format` needs a JSON-capable model, declared
//   tools need a tools-capable one, image parts need a vision-capable
//   one. The requirements come from the body, not from the brief's
//   manifest order, so a prompt is routed by what it asks for even if
//   the env ever sends it out of order.
//
// FAILOVER (10%) AND COOLDOWNS
//   A refusal is not an answer. On a 4xx or 5xx from the gateway (or an
//   unreachable gateway) this server tries the next candidate, and the
//   refusals it recovered from are reported on the response in the
//   `x-makefun-upstream-failures` header — the only way the failover
//   column can see a refusal that was retried and then served. A model
//   that refused is demoted below every model that refused less, for the
//   rest of the trial, and never dropped outright: when every fresher
//   candidate also refuses it is tried again as the last resort. The
//   order is a pure function of the brief, the request and the gateway
//   answers seen so far — no clock, no randomness — so a replay makes
//   the same choices. Retries are capped (8 per prompt, 56 per trial:
//   the gateway refuses past 60, and the tie-break is the call count).
//
// THE MODEL RULE
//   Whatever this server reports in a response's `model` field must be
//   the model it actually dialled. The house records every gateway call
//   and scores the model that really answered. This server sends the
//   brief's model id in the gateway request and puts that same id back on
//   every answer and every streamed chunk (the provider's own answer
//   spells it without the gateway's `openrouter/` prefix), so its claim
//   is the call it made, never another. A prompt whose reported model has
//   no matching successful call in the house's record earns nothing.
//
// THE CATALOG (5%)
//   The catalog lists every free model the brief names — exactly the
//   fourteen dialable ids the catalog column scores. The register body
//   and both GET /v1/models answers carry exactly that set, no more and
//   no fewer.
//
// FILES
//   main.ts            this server: the brief, the catalog, the routes, the register and the poll.
//   lib/brief.ts       the brief's types and parser, the free model list, the catalog.
//   lib/route.ts       model ranking, refusal memory, the failure trail.
//   lib/wire.ts        Anthropic <-> Chat Completions translation, the model field, the SSE writers.
//   LICENSE            MIT.
//   README.md          this design, in prose.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type Requirement,
} from './lib/brief.ts';
import { MAX_ATTEMPTS_PER_PROMPT, Router, failureCodeOf, trailHeader, type UpstreamFailure } from './lib/route.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The output cap the gateway requires, when the client named none (the gateway refuses over 8192). */
const DEFAULT_MAX_TOKENS = 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
const models = freeModels(brief);
const router = new Router();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return models.map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * A request's requirements, read off its own body: a JSON-mode
 * `response_format` needs JSON, declared tools need tools, image parts
 * need vision. The manifest is the declared source, but the body is what
 * the request asks for — routing by the body survives any arrival order.
 */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  // An Anthropic-shaped body carries its messages under `messages` too, and its tools under `tools`.
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    ...(vision ? { vision: true } : {}),
    ...(format === 'json_object' || format === 'json_schema' ? { json: true } : {}),
  };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function listModels(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST one request to the gateway's Chat Completions route, naming the model this server dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  router.noteCall();
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/**
 * The outbound Chat Completions body for a dial: the client's body with
 * the dialled model, an output cap (the gateway refuses a request with
 * none, or one over 8192), and usage on streamed answers.
 */
function outboundBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  if (typeof out.max_tokens !== 'number' && typeof out.max_completion_tokens !== 'number') {
    out.max_tokens = DEFAULT_MAX_TOKENS;
  }
  if (out.stream === true) out.stream_options = { include_usage: true };
  return out;
}

/** The trail header for a prompt's refusals, or {} when there were none. */
function trailHeaders(failures: readonly UpstreamFailure[]): Record<string, string> {
  const header = trailHeader(failures);
  return header === null ? {} : { 'x-makefun-upstream-failures': header };
}

/**
 * Dial the gateway for one prompt until a model answers, or the attempts
 * run out. Returns the answering model and its response, plus every
 * refusal the attempts met, in order.
 */
async function dialWithFailover(
  body: Json,
  requires: Requirement,
): Promise<{ model: string; upstream: Response; failures: UpstreamFailure[] } | { model: null; failures: UpstreamFailure[] }> {
  const failures: UpstreamFailure[] = [];
  const tried = new Set<string>();
  const candidates = router.candidates(models, requires, tried);
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= MAX_ATTEMPTS_PER_PROMPT || !router.canDial) break;
    attempts += 1;
    tried.add(candidate.id);
    let upstream: Response;
    try {
      upstream = await dial(candidate.id, outboundBody(body, candidate.id));
    } catch (err) {
      // Unreachable: a soft refusal (the trail records it, the order
      // does not — the next prompt tries this model first again).
      router.noteRefusal(candidate.id, false);
      failures.push({ status: 502, code: 'upstream_unreachable', model: candidate.id });
      log(`dial ${candidate.id} failed to reach the gateway: ${(err as Error).message}`);
      continue;
    }
    if (upstream.ok && upstream.body !== null) return { model: candidate.id, upstream, failures };
    const text = await upstream.text();
    // A 429 is a hard refusal (demotes for the trial); anything else is
    // soft (usually a transient server error).
    router.noteRefusal(candidate.id, upstream.status === 429);
    failures.push({ status: upstream.status, code: failureCodeOf(text, 'upstream_error'), model: candidate.id });
    log(`dial ${candidate.id} refused HTTP ${upstream.status}`);
  }
  return { model: null, failures };
}

/** A refused or broken gateway call as a 502 in the client's wire: the prompt is lost. */
function refused(res: ServerResponse, wire: 'openai' | 'anthropic', failures: readonly UpstreamFailure[]): void {
  const last = failures[failures.length - 1];
  const status = last?.status ?? 502;
  const detail = last !== undefined ? `the gateway answered HTTP ${last.status} (${last.code})` : 'the gateway answered nothing usable';
  if (wire === 'anthropic') {
    sendJson(res, 502, anthropicError('api_error', detail), trailHeaders(failures));
  } else {
    sendJson(res, 502, openAIError(detail, 'upstream_error', null), trailHeaders(failures));
  }
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFromBody(body);
  if (!models.some((m) => m.free && meetsRequirements(requires, m))) {
    return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
  }
  const result = await dialWithFailover(body, requires);
  if (result.model === null) return refused(res, 'openai', result.failures);
  const { model, upstream } = result;
  const headers = trailHeaders(result.failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for await (const frame of openAIStreamWithModel(upstream.body as ReadableStream<Uint8Array>, model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, model), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFromBody(body);
  if (!models.some((m) => m.free && meetsRequirements(requires, m))) {
    return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  }
  const translated = anthropicToOpenAI(body, 'auto');
  const result = await dialWithFailover(translated, requires);
  if (result.model === null) return refused(res, 'anthropic', result.failures);
  const { model, upstream } = result;
  const headers = trailHeaders(result.failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body as ReadableStream<Uint8Array>, model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, model), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    listModels(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
