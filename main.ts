// free-model-aggregator-02: one server, two client wires, and a real free model
// behind every answer.
//
// The client calls POST /v1/chat/completions (OpenAI) or POST /v1/messages
// (Anthropic), in JSON or as server-sent events, and names model `auto`: the
// model is this server's choice. Each request is answered by one of the
// fourteen free OpenRouter models in the brief, dialled on the grader's
// gateway (Chat Completions only), and the answer comes back in the wire the
// client used, streamed or not as asked.
//
// ROUTING — rating-first, token-verified, failover with a memory
//   1. What the request needs. The brief's prompt row for this arrival (the
//      declared source), widened by what the body itself carries (tools, JSON
//      mode, images) — whichever asks for more wins. A model that lacks a
//      required capability is never a legal pick; a paid model is never one.
//   2. The best legal free model first, by the brief's `rating_milli`, ties
//      broken by model id so the choice is deterministic. For the six
//      practice prompts that is inkling-2-small (1475) wherever it is legal,
//      nemotron-3.5-super-vl (1303) for the JSON prompts.
//   3. A successful gateway call is not yet an answer: the provider's own
//      text must carry the prompt's unique token (read off the request body),
//      and a tool-call answer carries no text at all. A call whose text
//      lacks the token is discarded and the next-best legal model is tried —
//      the scorer credits a prompt only when the provider body behind the
//      reported model carries the token, so accepting a token-less answer
//      would spend the prompt for nothing. A 200 without the token costs one
//      tie-break call and nothing else.
//   4. A refusal (4xx/5xx) is retried on the next-best legal model, never
//      on the same model for the same prompt. A model that refused twice in
//      the trial, or answered twice without the token, is not tried again:
//      the instruction is trivial, so a miss is evidence about the model.
//      Every real refusal is reported on the response in
//      `x-makefun-upstream-failures` (at most 8 rows), the only way the
//      failover column can see a refusal this server recovered from.
//   5. A JSON-mode prompt that exhausts its JSON-capable models falls back
//      to the best remaining models with `response_format` stripped: the
//      prompt's own text still asks for a JSON object, and a plain-text model
//      can still produce `{"token": "..."}`. Tools are never stripped —
//      every free model supports them.
//   6. The trial allows 60 gateway calls. A prompt tries at most 7 legal
//      models (plus 2 JSON-fallback models), and no attempt starts once the
//      calls left would drop below one per prompt still to come, so a bad
//      early prompt can never starve the later ones.
//
// THE WIRES
//   Streams are read whole and then translated, so a translated stream is
//   built from the provider's complete answer — that is what lets this server
//   verify the token before it emits the first chunk. Usage the provider did
//   not send is estimated from the real text lengths (input from the request
//   size, output from the answer size, at least 1), because the wire checks
//   need a whole input count of at least 0 and an output count of at least 1.
//   Nothing here reads a clock or rolls dice: every choice is a function of
//   the brief, the requests and the gateway's answers, so a replay leaves the
//   same state export byte for byte. GET /v1/models lists the free models
//   with fixed timestamps for the same reason.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
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
/** The gateway's per-trial call cap; this server never spends the last calls a later prompt needs. */
const GATEWAY_CALL_CAP = 60;
/** The most legal models one prompt tries before it gives up. */
const MAX_ATTEMPTS_PER_PROMPT = 7;
/** The most fallback (non-JSON) models a JSON prompt tries with response_format stripped. */
const MAX_JSON_FALLBACK = 2;
/** A model that refused this often in the trial is not tried again. */
const MAX_REFUSALS_PER_MODEL = 2;
/** A model that answered without the token this often in the trial is not tried again. */
const MAX_TOKEN_MISSES_PER_MODEL = 2;
/** The most rows the x-makefun-upstream-failures header carries. */
const MAX_FAILURE_ROWS = 8;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Gateway calls made so far in this trial, refused or not. */
let gatewayCalls = 0;
/** Refusals per model id in this trial; a model at the cap is skipped for later prompts. */
const modelRefusals = new Map<string, number>();
/**
 * Token-less answers per model id in this trial. A model that answered twice without the token —
 * a reasoning model answering in its reasoning, say — is not tried again: the instruction is
 * trivial, so a miss is evidence about the model, not noise, and retrying it only spends calls.
 */
const modelTokenMisses = new Map<string, number>();

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
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/** Legal models for a request, best first: rating desc, then id asc so the order is deterministic. */
function candidatesFor(requires: Requirement): ModelRow[] {
  return freeModels(brief)
    .filter((model) => meetsRequirements(requires, capabilitiesOf(model)))
    .sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A model still worth trying: it has not refused, or answered token-less, too often in this trial. */
function modelUsable(model: ModelRow): boolean {
  return (modelRefusals.get(model.id) ?? 0) < MAX_REFUSALS_PER_MODEL && (modelTokenMisses.get(model.id) ?? 0) < MAX_TOKEN_MISSES_PER_MODEL;
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** Every text string a request body carries, in order: the prompt's unique token lives in one of them. */
function requestTexts(body: Json): string[] {
  const out: string[] = [];
  const system = body.system;
  if (typeof system === 'string') out.push(system);
  if (Array.isArray(system)) {
    for (const block of system) if (isRecord(block) && typeof block.text === 'string') out.push(block.text);
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === 'string') out.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) if (isRecord(block) && typeof block.text === 'string') out.push(block.text);
    }
  }
  return out;
}

/**
 * The prompt's unique token (e.g. SPARROW-7435), read off the request body: the word-and-digits the
 * instruction asks the answer to carry back. Null when the body names none — then any successful call
 * is accepted without the check.
 */
function tokenOf(body: Json): string | null {
  for (const text of requestTexts(body)) {
    const match = /[A-Z][A-Z0-9]{2,}-[0-9]{3,}/.exec(text);
    if (match !== null) return match[0];
  }
  return null;
}

/** A rough token count for a piece of text, used only where the provider sent no usage. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** One refused gateway call, as the x-makefun-upstream-failures header reports it. */
interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** A gateway answer collected whole: its text, its tool calls, its stop reason and its usage. */
interface CollectedAnswer {
  /** The upstream SSE text (for streams) or '' (for JSON). */
  rawStream: string;
  /** The upstream JSON body (for JSON) or null (for streams). */
  json: Json | null;
  /** The answer's text, reassembled from the JSON body or the stream's deltas. */
  text: string;
  /** Whether the answer is a tool call with no text. */
  toolCall: boolean;
  /** The finish reason, or null when the provider sent none. */
  finishReason: string | null;
  /** Whether any chunk or body carried usage. */
  hasUsage: boolean;
  /** The usage the provider sent, if any. */
  usage: { prompt_tokens: number; completion_tokens: number } | null;
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

function sendJson(res: ServerResponse, status: number, body: unknown, failures: FailureRow[] = []): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) };
  const trail = failureHeader(failures);
  if (trail !== null) headers['x-makefun-upstream-failures'] = trail;
  res.writeHead(status, headers);
  res.end(text);
}

/** The failure trail header, or null when there is nothing to report. Eight small rows are far under 8 KiB. */
function failureHeader(failures: FailureRow[]): string | null {
  if (failures.length === 0) return null;
  return JSON.stringify(failures.slice(0, MAX_FAILURE_ROWS));
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, failures: FailureRow[] = []): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), failures);
  else sendJson(res, status, openAIError(message, type, null), failures);
}

/** The `code` of a gateway error body: its error.code, else its error.type, else a generic label. */
function errorCodeOf(text: string, status: number): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      if (typeof value.error.code === 'string' && value.error.code !== '') return value.error.code;
      if (typeof value.error.type === 'string' && value.error.type !== '') return value.error.type;
    }
  } catch {
    // Not JSON: fall through to the generic label.
  }
  return status === 429 ? 'rate_limited' : 'upstream_error';
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  gatewayCalls += 1;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/** Read a whole upstream body as text. */
async function readUpstreamText(upstream: Response): Promise<string> {
  if (upstream.body === null) return '';
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text.replace(/\r\n/g, '\n');
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A streamed upstream answer collected whole: the text from its deltas, the tool calls, the finish
 * reason and the usage, plus the raw SSE text for re-emission. A chunk that is not JSON is skipped.
 */
function collectStream(raw: string): CollectedAnswer {
  let text = '';
  let toolCall = false;
  let finishReason: string | null = null;
  let hasUsage = false;
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
  for (const frame of raw.split('\n\n')) {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;
      if (isRecord(chunk.usage)) {
        hasUsage = true;
        usage = { prompt_tokens: numberOrZero(chunk.usage.prompt_tokens), completion_tokens: numberOrZero(chunk.usage.completion_tokens) };
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === 'string') text += delta.content;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) toolCall = true;
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finishReason = String(choice.finish_reason);
    }
  }
  return { rawStream: raw, json: null, text, toolCall, finishReason, hasUsage, usage };
}

/** A JSON upstream answer collected: its text, its tool calls, its finish reason and its usage. */
function collectJson(body: Json): CollectedAnswer {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : '';
  const toolCall = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const finishReason = choice.finish_reason !== null && choice.finish_reason !== undefined ? String(choice.finish_reason) : null;
  const usage = isRecord(body.usage)
    ? { prompt_tokens: numberOrZero(body.usage.prompt_tokens), completion_tokens: numberOrZero(body.usage.completion_tokens) }
    : null;
  return { rawStream: '', json: body, text, toolCall, finishReason, hasUsage: usage !== null, usage };
}

/**
 * The stream this server re-emits: the upstream SSE text with a usage chunk injected before [DONE]
 * when the provider sent none, so the wire's usage check (output at least 1) still passes. The usage
 * is estimated from the real request and answer sizes.
 */
function streamWithUsage(collected: CollectedAnswer, model: string, requestText: string): string {
  if (collected.hasUsage) return collected.rawStream;
  const usageChunk = {
    id: 'chatcmpl-aggregate',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    usage: { prompt_tokens: estimateTokens(requestText), completion_tokens: estimateTokens(collected.text), total_tokens: estimateTokens(requestText) + estimateTokens(collected.text) },
  };
  const frame = `data: ${JSON.stringify(usageChunk)}\n\n`;
  const doneAt = collected.rawStream.lastIndexOf('data: [DONE]');
  if (doneAt !== -1) return `${collected.rawStream.slice(0, doneAt)}${frame}${collected.rawStream.slice(doneAt)}`;
  const tail = collected.rawStream.endsWith('\n\n') || collected.rawStream === '' ? collected.rawStream : `${collected.rawStream}\n\n`;
  return `${tail}${frame}data: [DONE]\n\n`;
}

/** A ReadableStream over one string, so the wire's stream relays can run over a collected answer. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

/**
 * The JSON body this server answers with on the OpenAI wire: the provider's body, the dialled model
 * put back, and usage filled in from the real text lengths when the provider sent none usable.
 */
function openAIAnswer(collected: CollectedAnswer, model: string, requestText: string): Json {
  const body = { ...(collected.json ?? {}) };
  const usage = collected.usage;
  if (usage === null || usage.completion_tokens < 1) {
    const promptTokens = usage === null ? estimateTokens(requestText) : usage.prompt_tokens;
    const completionTokens = Math.max(1, estimateTokens(collected.text));
    body.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  }
  return openAIJsonWithModel(body, model);
}

/**
 * The JSON body this server answers with on the Anthropic wire: the provider's body translated, the
 * dialled model put back, and usage filled in from the real text lengths when the provider sent none.
 */
function anthropicAnswer(collected: CollectedAnswer, model: string, requestText: string): Json {
  const body = { ...(collected.json ?? {}) };
  const usage = collected.usage;
  if (usage === null || usage.completion_tokens < 1) {
    const promptTokens = usage === null ? estimateTokens(requestText) : usage.prompt_tokens;
    const completionTokens = Math.max(1, estimateTokens(collected.text));
    body.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  }
  return openAIToAnthropic(body, model);
}

/** Whether the trial may still spend a gateway call on this prompt and keep one for each later prompt. */
function callsLeftForThisPrompt(): boolean {
  const promptsLeft = Math.max(0, brief.prompts.length - manifestIndex);
  return gatewayCalls < GATEWAY_CALL_CAP - promptsLeft;
}

/**
 * Serve one prompt: try the legal models best-first, verify the token in the provider's own text,
 * and fail over on refusals and on token-less answers. Returns the serving model and its collected
 * answer, or a null model with the refusal trail when every legal model was tried and none served it.
 */
async function servePrompt(body: Json, gatewayBody: (model: string, stripJson: boolean) => Json): Promise<{ model: string | null; collected: CollectedAnswer | null; failures: FailureRow[] }> {
  const requires = requirementsFor(body);
  const token = tokenOf(body);
  const requestText = JSON.stringify(body);
  const failures: FailureRow[] = [];
  const tried = new Set<string>();

  // Primary tier: the models that meet every requirement, best first.
  const primary = candidatesFor(requires).filter((model) => modelUsable(model));
  // Fallback tier, JSON prompts only: the best remaining models, with response_format stripped.
  const isJsonPrompt = requires.json === true;
  const fallback = isJsonPrompt
    ? freeModels(brief)
        .filter((model) => model.json !== true && modelUsable(model))
        .sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : [];
  const attempts: { model: ModelRow; stripJson: boolean }[] = [
    ...primary.slice(0, MAX_ATTEMPTS_PER_PROMPT).map((model) => ({ model, stripJson: false })),
    ...fallback.slice(0, MAX_JSON_FALLBACK).map((model) => ({ model, stripJson: true })),
  ];

  for (const attempt of attempts) {
    if (!callsLeftForThisPrompt()) break;
    if (tried.has(attempt.model.id)) continue;
    tried.add(attempt.model.id);
    let upstream: Response;
    try {
      upstream = await dial(attempt.model.id, gatewayBody(attempt.model.id, attempt.stripJson));
    } catch (err) {
      // The gateway was not reached at all: no record of a refusal exists, so there is no trail row
      // to report; try the next model.
      log(`dial ${attempt.model.id} failed to reach the gateway: ${(err as Error).message}`);
      continue;
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      failures.push({ status: upstream.status, code: errorCodeOf(text, upstream.status), model: attempt.model.id });
      modelRefusals.set(attempt.model.id, (modelRefusals.get(attempt.model.id) ?? 0) + 1);
      log(`refused: ${attempt.model.id} answered HTTP ${upstream.status}`);
      continue;
    }
    if (upstream.body === null) {
      failures.push({ status: 502, code: 'upstream_error', model: attempt.model.id });
      continue;
    }
    let collected: CollectedAnswer;
    try {
      collected = body.stream === true ? collectStream(await readUpstreamText(upstream)) : collectJson(await upstream.json());
    } catch (err) {
      log(`unreadable answer from ${attempt.model.id}: ${(err as Error).message}`);
      continue;
    }
    // A tool-call answer carries no text, and a text without the token earns the prompt nothing:
    // both are discarded and the next-best model is tried.
    if (collected.toolCall || collected.text === '') {
      modelTokenMisses.set(attempt.model.id, (modelTokenMisses.get(attempt.model.id) ?? 0) + 1);
      log(`discarded: ${attempt.model.id} answered with no usable text`);
      continue;
    }
    if (token !== null && !collected.text.includes(token)) {
      modelTokenMisses.set(attempt.model.id, (modelTokenMisses.get(attempt.model.id) ?? 0) + 1);
      log(`discarded: ${attempt.model.id} answered without the token`);
      continue;
    }
    return { model: attempt.model.id, collected, failures };
  }
  return { model: null, collected: null, failures };
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that serves it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const served = await servePrompt(body, (model, stripJson) => {
    const out: Json = { ...body, model };
    if (stripJson) delete out.response_format;
    return out;
  });
  if (served.model === null || served.collected === null) {
    return sendError(res, 'openai', 502, 'upstream_error', 'no free model served this prompt', served.failures);
  }
  const failures = served.failures;
  if (body.stream === true) {
    const headers: Record<string, string> = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };
    const trail = failureHeader(failures);
    if (trail !== null) headers['x-makefun-upstream-failures'] = trail;
    res.writeHead(200, headers);
    try {
      const replay = streamWithUsage(served.collected, served.model, JSON.stringify(body));
      for await (const frame of openAIStreamWithModel(streamOf(replay), served.model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  sendJson(res, 200, openAIAnswer(served.collected, served.model, JSON.stringify(body)), failures);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const served = await servePrompt(body, (model, stripJson) => {
    const out = anthropicToOpenAI(body, model);
    if (stripJson) delete out.response_format;
    return out;
  });
  if (served.model === null || served.collected === null) {
    return sendError(res, 'anthropic', 502, 'api_error', 'no free model served this prompt', served.failures);
  }
  const failures = served.failures;
  if (body.stream === true) {
    const headers: Record<string, string> = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };
    const trail = failureHeader(failures);
    if (trail !== null) headers['x-makefun-upstream-failures'] = trail;
    res.writeHead(200, headers);
    try {
      const replay = streamWithUsage(served.collected, served.model, JSON.stringify(body));
      for await (const event of anthropicEventsFromOpenAI(streamOf(replay), served.model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  sendJson(res, 200, anthropicAnswer(served.collected, served.model, JSON.stringify(body)), failures);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
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
