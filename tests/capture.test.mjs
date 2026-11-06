/**
 * T2 host capture: access-before-read, stable-boundary sampling, coalescing,
 * transparent LLM stream passthrough, late-usage accounting and read-back.
 *
 * Fake Host adapters only: no network, no real model, no real Harness session.
 * The fake context implements exactly the rc.5 event semantics our adapter
 * binds to (`ctx.on`, waterfall `(options, next)`, agent waterfall payload with
 * `agent`), so `createRc5Host` is exercised for real against fake installed
 * bytes semantics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  canonicalJson,
  sha256Hex,
  validateObservation,
} from '../src/contracts.mjs';
import { createAccessRegistry } from '../src/access.mjs';
import { createObservationStore } from '../src/observations.mjs';
import { createRc5Host } from '../src/host-rc5.mjs';
import { createCapture } from '../src/capture.mjs';

const CAPTURED_AT = '2026-11-07T00:00:00.000Z';
const fixedClock = () => new Date(CAPTURED_AT);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hex64(seed = 'scope') {
  const alphabet = '0123456789abcdef';
  let text = '';
  for (let index = 0; index < 64; index += 1) {
    text += alphabet[(seed.charCodeAt(index % seed.length) + index * 7) % 16];
  }
  return text;
}

function scopeRef(overrides = {}) {
  return { scope_id: 'project-a', generation: 3, identity_digest: hex64('project-a'), ...overrides };
}

function bindingFor(sessionRef) {
  return {
    context_ref: `ctx-${sessionRef}`,
    session_ref: sessionRef,
    scope: scopeRef(),
    read: true,
    export_root_refs: [],
    active: true,
  };
}

function registryFor(sessionRefs) {
  return {
    schema_version: 1,
    revision: 1,
    bindings: sessionRefs.map(bindingFor),
    export_roots: [],
  };
}

function userMessage(id, text = 'hello') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

// ---------------------------------------------------------------------------
// fake rc.5-shaped host surface
// ---------------------------------------------------------------------------

class FakeSession {
  constructor(id, options = {}) {
    this.id = id;
    this.header = { version: 4, id, createdAt: 0, isSeeded: false, ...options.header };
    this.messages = options.messages ?? [userMessage(`msg-${id}`, `hello ${id}`)];
    this.tool_definitions = options.tool_definitions ?? [];
    this.last_event_seq = options.last_event_seq ?? 1;
    this.surface_generation = options.surface_generation ?? 0;
    this.deriveCalls = 0;
    this.onDerive = null;
  }

  get seq() {
    return this.last_event_seq;
  }

  get surface() {
    return { contentGeneration: this.surface_generation };
  }

  deriveMessages() {
    this.deriveCalls += 1;
    if (typeof this.onDerive === 'function') this.onDerive(this);
    return this.messages.slice();
  }

  requestHeader() {
    if (this.tool_definitions.length === 0) return undefined;
    return { config: { provider: 'fake', model: 'fake-model' }, tools: this.tool_definitions };
  }
}

function createFakeCtx(sessions) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  const ctx = {
    handlers,
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    sessions: {
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
    },
    on(name, callback) {
      const list = handlers.get(name) ?? [];
      list.push(callback);
      handlers.set(name, list);
      return () => {
        const current = handlers.get(name);
        if (current === undefined) return;
        const index = current.indexOf(callback);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) handlers.delete(name);
      };
    },
    emit(name, ...args) {
      for (const callback of [...(handlers.get(name) ?? [])]) callback(...args);
    },
    listenerCount(name) {
      return (handlers.get(name) ?? []).length;
    },
  };
  return ctx;
}

function fakeRedactor() {
  return { policyRevision: 'REDACT-1', redactText: (text) => ({ text, count: 0, categories: [] }) };
}

function createFakeProjector() {
  const calls = { project: 0, collect: 0, digest: 0, failProject: false, failCollect: false };
  return {
    calls,
    projectMessages({ messages }) {
      calls.project += 1;
      if (calls.failProject) throw new Error('projection boom');
      const groups = messages.map((message, index) => ({
        group_id: `group-${index}-${message.role}`,
        category: message.role === 'tool' ? 'tool_result' : message.role,
        source_ref: null,
        source_kind: message.source?.kind ?? null,
        message_refs: [message.id],
        characters: 2,
        bytes: 2,
        estimated_tokens: 2,
        certainty: 'identified',
        preview: 'hi',
        truncated: false,
        redaction_count: 0,
      }));
      return {
        groups,
        estimate: { method: 'utf8_bytes_estimate_v1', tokenizer_ref: null, tokens: groups.length * 2, complete: true, unpriced_modalities: [] },
        totals: { characters: groups.length * 2, bytes: groups.length * 2 },
        truncated: false,
        omitted_bytes: 0,
        unpriced_modalities: [],
        observed_digest: sha256Hex(canonicalJson(messages.map((message) => ({ id: message.id, role: message.role, content: message.content })))),
        redaction_total: 0,
      };
    },
    collectGroupTexts({ messages }) {
      calls.collect += 1;
      if (calls.failCollect) throw new Error('collect boom');
      return {
        groups: new Map(messages.map((message, index) => [
          `group-${index}-${message.role}`,
          {
            text: message.content.map((block) => block.text ?? '').join(''),
            characters: 2,
            bytes: 2,
            redaction_count: 0,
          },
        ])),
        truncated: false,
      };
    },
    computeObservedDigest(fragment) {
      calls.digest += 1;
      return sha256Hex(canonicalJson(fragment));
    },
  };
}

function makeHarness(overrides = {}) {
  const sessionIds = overrides.sessionIds ?? ['session-a', 'session-b'];
  const sessions = new Map();
  for (const id of sessionIds) {
    sessions.set(id, new FakeSession(id, overrides.sessions?.[id] ?? {}));
  }
  const ctx = createFakeCtx(sessions);
  const host = createRc5Host(ctx);
  const store = createObservationStore({ limits: overrides.limits ?? LIMITS, clock: fixedClock });
  const access = overrides.access ?? createAccessRegistry({ registry: registryFor(overrides.boundSessions ?? ['session-a']) });
  const projector = overrides.projector ?? createFakeProjector();
  const config = {
    autoSampleSurface: true,
    requestObservation: true,
    agentPreStep: true,
    coalesceWindowMs: 10,
    maxRefreshHz: 20,
    ...overrides.config,
  };
  const capture = createCapture({
    host,
    access,
    store,
    redactor: fakeRedactor(),
    policy: { redactionPolicyRevision: 'REDACT-1' },
    clock: fixedClock,
    limits: overrides.limits ?? LIMITS,
    config,
    logger: ctx.logger,
    projector,
  });
  return { ctx, host, store, access, projector, capture, config, sessions, sessionA: sessions.get('session-a'), sessionB: sessions.get('session-b') };
}

/** Run the fake `llm/stream` waterfall the way rc.5 does: (options, next) chain. */
function runLlmWaterfall(ctx, options, makeAdapterStream) {
  const handlers = [...(ctx.handlers.get('llm/stream') ?? [])];
  let fallbackCalls = 0;
  let producedStream = null;
  let index = 0;
  const fallback = () => {
    fallbackCalls += 1;
    producedStream = makeAdapterStream();
    return producedStream;
  };
  const next = () => {
    const handler = handlers[index];
    index += 1;
    return handler === undefined ? fallback() : handler(options, next);
  };
  const result = next();
  return {
    result,
    fallbackCalls: () => fallbackCalls,
    producedStream: () => producedStream,
  };
}

async function* streamFromChunks(chunks) {
  for (const chunk of chunks) yield chunk;
}

function surfaceEvent(session, seq, extra = {}) {
  return { type: 'user/message', seq, data: { message: userMessage(`msg-${seq}`, 'x') }, surfaceOp: 'append', ...extra };
}

function llmEntries(store, sessionRef = 'session-a') {
  return store.entriesForSession(sessionRef).filter((entry) => entry.stage === 'llm_waterfall');
}

// ---------------------------------------------------------------------------
// access-before-read and stable surface sampling
// ---------------------------------------------------------------------------

test('captureSurface denies unbound sessions before any content read', async () => {
  const harness = makeHarness({ boundSessions: ['session-a'] });
  const result = await harness.capture.captureSurface({ binding: bindingFor('session-b'), stage: 'session_surface' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reasonCode, 'CONTEXT_UNBOUND');
  assert.equal(harness.sessionB.deriveCalls, 0, 'unbound session content is never read');
  assert.equal(harness.store.stats().entries, 0);
  harness.capture.dispose();
});

test('background sampling only touches authorized sessions', async () => {
  const harness = makeHarness({ boundSessions: ['session-a'] });
  const dispose = harness.capture.install();
  harness.sessionB.last_event_seq += 1;
  harness.ctx.emit('session/event', harness.sessionB, surfaceEvent(harness.sessionB, 2));
  await sleep(40);
  assert.equal(harness.sessionB.deriveCalls, 0, 'unbound session is never sampled');
  assert.equal(harness.store.stats().entries, 0);

  harness.sessionA.last_event_seq += 1;
  harness.ctx.emit('session/event', harness.sessionA, surfaceEvent(harness.sessionA, 2));
  await sleep(40);
  assert.equal(harness.sessionA.deriveCalls, 1);
  const latest = harness.store.getLatest('session-a', 'session_surface');
  assert.equal(latest.session_ref, 'session-a');
  assert.equal(latest.observation.capture_stage, 'session_surface');
  dispose();
  harness.capture.dispose();
});

test('captureSurface returns a contract-valid history projection at a stable boundary', async () => {
  const harness = makeHarness();
  const result = await harness.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' });
  assert.equal(result.status, 'ok');
  const observation = result.observation;
  assert.equal(validateObservation(observation).ok, true, JSON.stringify(validateObservation(observation).errors));
  assert.equal(observation.capture_stage, 'session_surface');
  assert.equal(observation.fidelity, 'history_projection');
  assert.equal(observation.wire_verified, false);
  assert.equal(observation.request_ref, null);
  assert.equal(observation.boundary.session_ref, 'session-a');
  assert.equal(observation.boundary.last_event_seq, 1);
  assert.equal(observation.boundary.surface_generation, 0);
  assert.equal(observation.boundary.scope.generation, 3);
  assert.equal(observation.captured_at, CAPTURED_AT);
  assert.match(observation.observed_digest, /^[0-9a-f]{64}$/);
  assert.equal(observation.revision, 1);
  assert.deepEqual(harness.projector.calls, { project: 1, collect: 0, digest: 0, failProject: false, failCollect: false });

  const duplicate = await harness.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' });
  assert.equal(duplicate.status, 'ok');
  assert.equal(duplicate.observation.revision, 1, 'same surface+digest is deduped by the store');
  assert.equal(harness.store.stats().deduped, 1);
  harness.capture.dispose();
});

test('a surface change during deriveMessages retries exactly once', async () => {
  const harness = makeHarness();
  harness.sessionA.onDerive = (session) => {
    session.last_event_seq += 1;
    session.onDerive = null;
  };
  const result = await harness.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' });
  assert.equal(result.status, 'ok');
  assert.equal(harness.sessionA.deriveCalls, 2, 'first read was discarded, exactly one retry');
  assert.equal(result.observation.boundary.last_event_seq, 2, 'the stable boundary from the retry is recorded');
  harness.capture.dispose();
});

test('a boundary that keeps moving is reported stale after one retry and never cached', async () => {
  const harness = makeHarness();
  harness.sessionA.onDerive = (session) => { session.last_event_seq += 1; };
  const result = await harness.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' });
  assert.equal(result.status, 'stale');
  assert.equal(result.reasonCode, 'STALE_OBSERVATION');
  assert.equal(harness.sessionA.deriveCalls, 2, 'one retry then give up');
  assert.equal(harness.store.stats().entries, 0);
  assert.equal(harness.projector.calls.project, 0, 'unstable content is never projected or cached');
  harness.capture.dispose();
});

test('cache write re-checks the binding generation before storing', async () => {
  const binding = bindingFor('session-a');
  let calls = 0;
  const access = {
    bindingForSession() {
      calls += 1;
      if (calls <= 1) return binding;
      return { ...binding, scope: { ...binding.scope, generation: binding.scope.generation + 1 } };
    },
  };
  const harness = makeHarness({ access });
  const result = await harness.capture.captureSurface({ binding, stage: 'session_surface' });
  assert.equal(result.status, 'stale');
  assert.equal(result.reasonCode, 'STALE_SCOPE');
  assert.equal(harness.store.stats().entries, 0, 'a stale scope generation never enters the cache');
  harness.capture.dispose();
});

test('concurrent captureSurface calls share one sampling run per session', async () => {
  const harness = makeHarness();
  const results = await Promise.all([
    harness.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' }),
    harness.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' }),
  ]);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[1].status, 'ok');
  assert.equal(harness.sessionA.deriveCalls, 1, 'at most one sampling in flight per session');
  harness.capture.dispose();
});

// ---------------------------------------------------------------------------
// coalescing / rate limit
// ---------------------------------------------------------------------------

test('session events coalesce into one sample per window and stay under the refresh rate', async () => {
  const harness = makeHarness();
  const dispose = harness.capture.install();
  harness.sessionA.last_event_seq += 1;
  for (let index = 0; index < 6; index += 1) {
    harness.ctx.emit('session/event', harness.sessionA, surfaceEvent(harness.sessionA, harness.sessionA.last_event_seq));
  }
  await sleep(60);
  assert.equal(harness.sessionA.deriveCalls, 1, 'a synchronous burst produces one coalesced sample');

  const before = harness.sessionA.deriveCalls;
  const started = Date.now();
  while (Date.now() - started < 120) {
    harness.sessionA.last_event_seq += 1;
    harness.ctx.emit('session/event', harness.sessionA, surfaceEvent(harness.sessionA, harness.sessionA.last_event_seq));
    await sleep(5);
  }
  await sleep(40);
  const samples = harness.sessionA.deriveCalls - before;
  assert.ok(samples >= 1, 'continuous events still refresh');
  assert.ok(samples <= 4, `max 20 Hz over ~160 ms means a handful of samples, got ${samples}`);

  const unboundBefore = harness.sessionB.deriveCalls;
  harness.ctx.emit('session/event', harness.sessionB, surfaceEvent(harness.sessionB, 2));
  await sleep(40);
  assert.equal(harness.sessionB.deriveCalls, unboundBefore, 'unbound session events never sample');
  dispose();
  harness.capture.dispose();
});

// ---------------------------------------------------------------------------
// transparent llm/stream middleware
// ---------------------------------------------------------------------------

const CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hello' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
];

function llmOptions(sessionId = 'session-a', signal = undefined) {
  return {
    provider: 'fake',
    model: 'fake-model',
    sessionId,
    messages: [userMessage('msg-request-1', 'request text')],
    tools: [],
    signal,
  };
}

test('llm/stream middleware is transparent and captures provider usage after completion', async () => {
  const harness = makeHarness();
  harness.capture.install();
  const options = llmOptions();
  const before = JSON.stringify(options);
  const run = runLlmWaterfall(harness.ctx, options, () => streamFromChunks(CHUNKS));
  const received = [];
  for await (const chunk of run.result) received.push(chunk);

  assert.equal(run.fallbackCalls(), 1, 'the downstream stream is created exactly once');
  assert.equal(received.length, CHUNKS.length);
  received.forEach((chunk, index) => assert.equal(chunk, CHUNKS[index], `chunk ${index} keeps object identity`));
  assert.equal(JSON.stringify(options), before, 'options are never modified');

  const entries = llmEntries(harness.store);
  assert.equal(entries.length, 1);
  const observation = entries[0].observation;
  assert.equal(validateObservation(observation).ok, true, JSON.stringify(validateObservation(observation).errors));
  assert.equal(observation.capture_stage, 'llm_waterfall');
  assert.equal(observation.fidelity, 'request_observed');
  assert.equal(observation.wire_verified, false);
  assert.match(observation.request_ref, /^ctx-req-/);
  assert.equal(observation.provider_ref, 'fake');
  assert.equal(observation.model_ref, 'fake-model');
  assert.equal(observation.boundary.session_ref, 'session-a');
  assert.equal(observation.reported_usage.source, 'provider_usage_chunk');
  assert.equal(observation.reported_usage.request_ref, observation.request_ref);
  assert.equal(observation.reported_usage.input_tokens, 11);
  assert.equal(observation.reported_usage.output_tokens, 7);
  assert.equal(observation.reported_usage.cached_input_tokens, 3);
  assert.equal(observation.reported_usage.is_final, true);
  assert.equal(harness.store.getLatest('session-a', 'llm_waterfall').revision, observation.revision);
  harness.capture.dispose();
});

test('llm/stream middleware leaves unbound sessions completely untouched', async () => {
  const harness = makeHarness({ boundSessions: ['session-a'] });
  harness.capture.install();
  const options = llmOptions('session-b');
  const before = JSON.stringify(options);
  const run = runLlmWaterfall(harness.ctx, options, () => streamFromChunks(CHUNKS));
  assert.equal(run.result, run.producedStream(), 'unbound stream is passed through without a wrapper');
  const received = [];
  for await (const chunk of run.result) received.push(chunk);
  assert.equal(received.length, CHUNKS.length);
  assert.equal(JSON.stringify(options), before);
  assert.equal(harness.store.stats().entries, 0);
  assert.equal(harness.projector.calls.project, 0, 'unbound request content is never projected');
  harness.capture.dispose();
});

test('main-request errors pass through and observation failures never break the stream', async () => {
  const boom = new Error('adapter boom');
  async function* failing() {
    yield CHUNKS[0];
    throw boom;
  }
  const harness = makeHarness();
  harness.capture.install();
  const run = runLlmWaterfall(harness.ctx, llmOptions(), () => failing());
  const received = [];
  await assert.rejects(async () => {
    for await (const chunk of run.result) received.push(chunk);
  }, (error) => error === boom);
  assert.equal(received.length, 1);
  assert.equal(received[0], CHUNKS[0]);
  const entries = llmEntries(harness.store);
  assert.equal(entries.length, 1, 'the observed request is still recorded without usage');
  assert.equal(entries[0].observation.reported_usage, null);

  const failingProjection = createFakeProjector();
  failingProjection.calls.failProject = true;
  const second = makeHarness({ projector: failingProjection });
  second.capture.install();
  const okRun = runLlmWaterfall(second.ctx, llmOptions(), () => streamFromChunks(CHUNKS));
  const all = [];
  for await (const chunk of okRun.result) all.push(chunk);
  assert.equal(all.length, CHUNKS.length, 'projection failure drops only the observation');
  assert.equal(second.store.stats().entries, 0);
  harness.capture.dispose();
  second.capture.dispose();
});

test('late usage after cancellation stays with the original request and is non-final', async () => {
  const harness = makeHarness();
  harness.capture.install();
  const controller = new AbortController();
  const firstChunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
    { type: 'finish', reason: { kind: 'aborted' } },
  ];
  async function* cancelledStream() {
    yield firstChunks[0];
    controller.abort();
    yield firstChunks[1];
    yield firstChunks[2];
  }
  const firstRun = runLlmWaterfall(harness.ctx, llmOptions('session-a', controller.signal), () => cancelledStream());
  for await (const chunk of firstRun.result) { /* consume */ }

  const secondChunks = [
    { type: 'usage', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const secondRun = runLlmWaterfall(harness.ctx, llmOptions('session-a', new AbortController().signal), () => streamFromChunks(secondChunks));
  for await (const chunk of secondRun.result) { /* consume */ }

  const entries = llmEntries(harness.store).map((entry) => entry.observation);
  assert.equal(entries.length, 2);
  const [first, second] = entries;
  assert.notEqual(first.request_ref, second.request_ref, 'request refs are per local request sequence');
  assert.equal(first.reported_usage.request_ref, first.request_ref);
  assert.equal(first.reported_usage.input_tokens, 5, 'late usage stays attached to the cancelled request');
  assert.equal(first.reported_usage.is_final, false);
  assert.equal(second.reported_usage.request_ref, second.request_ref);
  assert.equal(second.reported_usage.input_tokens, 9);
  assert.equal(second.reported_usage.is_final, true);
  harness.capture.dispose();
});

// ---------------------------------------------------------------------------
// agent/pre-step tagging
// ---------------------------------------------------------------------------

test('agent/pre-step is tagged for authorized sessions and the decision is returned unmodified', async () => {
  const harness = makeHarness();
  harness.capture.install();
  const decision = { kind: 'enter', messages: [] };
  const fallback = () => decision;
  const payload = { agent: { session: harness.sessionA }, messages: [userMessage('m1')], turn: 2, step: 1, signal: new AbortController().signal };
  const snapshot = JSON.stringify(payload);
  const handlers = [...(harness.ctx.handlers.get('agent/pre-step') ?? [])];
  assert.equal(handlers.length, 1);
  let index = 0;
  const next = () => (handlers[index] ? handlers[index++](payload, next) : fallback());
  const result = next();
  assert.equal(result, decision, 'the existing waterfall decision object is returned as-is');
  assert.equal(JSON.stringify(payload), snapshot, 'the pre-step payload is never modified');
  assert.equal(harness.projector.calls.project, 0, 'pre-step tagging reads no content');
  assert.equal(harness.store.stats().entries, 0);
  assert.equal(harness.capture.describe().pre_step_tags, 1);

  const unbound = { agent: { session: harness.sessionB }, messages: [], turn: 0, step: 0, signal: new AbortController().signal };
  const unboundDecision = { kind: 'enter', messages: [] };
  assert.equal(next2(harness.ctx, unbound, unboundDecision), unboundDecision);
  assert.equal(harness.capture.describe().pre_step_tags, 1, 'unbound agents are not tagged');
  harness.capture.dispose();
});

function next2(ctx, payload, decision) {
  const handlers = [...(ctx.handlers.get('agent/pre-step') ?? [])];
  let index = 0;
  const next = () => (handlers[index] ? handlers[index++](payload, next) : decision);
  return next();
}

// ---------------------------------------------------------------------------
// readGroupTexts
// ---------------------------------------------------------------------------

test('readGroupTexts re-reads the live surface, matches the boundary, then returns redacted texts', async () => {
  const harness = makeHarness();
  const captured = await harness.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' });
  assert.equal(captured.status, 'ok');

  const ok = await harness.capture.readGroupTexts({ binding: bindingFor('session-a'), observation: captured.observation });
  assert.equal(ok.status, 'ok');
  assert.ok(ok.groups instanceof Map);
  assert.deepEqual([...ok.groups.keys()], ['group-0-user']);
  assert.equal(ok.groups.get('group-0-user').text, 'hello session-a');
  assert.equal(harness.projector.calls.collect, 1);

  harness.sessionA.last_event_seq += 1;
  const stale = await harness.capture.readGroupTexts({ binding: bindingFor('session-a'), observation: captured.observation });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reasonCode, 'STALE_OBSERVATION');
  assert.equal(harness.projector.calls.collect, 1, 'changed surface is not projected again');
  harness.capture.dispose();
});

test('readGroupTexts denies revoked bindings before reading the session', async () => {
  const source = makeHarness();
  const captured = await source.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' });
  assert.equal(captured.status, 'ok');

  const revoked = makeHarness({ access: { bindingForSession: () => null } });
  const result = await revoked.capture.readGroupTexts({ binding: bindingFor('session-a'), observation: captured.observation });
  assert.equal(result.status, 'denied');
  assert.equal(result.reasonCode, 'CONTEXT_UNBOUND');
  assert.equal(revoked.sessionA.deriveCalls, 0, 'revoked binding never reads content');
  source.capture.dispose();
  revoked.capture.dispose();
});

// ---------------------------------------------------------------------------
// invalidation, dispose, defaults and real projection wiring
// ---------------------------------------------------------------------------

test('surface replacement events invalidate the cached snapshot before re-sampling', async () => {
  const harness = makeHarness();
  const dispose = harness.capture.install();
  const first = await harness.capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' });
  assert.equal(first.status, 'ok');
  const revisionBefore = first.observation.revision;

  harness.sessionA.surface_generation += 1;
  harness.sessionA.last_event_seq += 1;
  harness.ctx.emit('session/event', harness.sessionA, {
    type: 'tool/result', seq: harness.sessionA.last_event_seq, data: {}, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
  });
  await sleep(40);
  const latest = harness.store.getLatest('session-a', 'session_surface');
  assert.equal(latest.observation.boundary.surface_generation, 1);
  assert.ok(latest.observation.revision > revisionBefore, 'replacement produces a new revision, not a stale cached one');
  dispose();
  harness.capture.dispose();
});

test('capture dispose unregisters every Host listener and cancels pending sampling', async () => {
  const harness = makeHarness();
  const dispose = harness.capture.install();
  assert.equal(harness.ctx.listenerCount('session/event'), 1);
  assert.equal(harness.ctx.listenerCount('session/disposed'), 1);
  assert.equal(harness.ctx.listenerCount('llm/stream'), 1);
  assert.equal(harness.ctx.listenerCount('agent/pre-step'), 1);

  harness.sessionA.last_event_seq += 1;
  harness.ctx.emit('session/event', harness.sessionA, surfaceEvent(harness.sessionA, 2));
  dispose();
  assert.equal(harness.ctx.listenerCount('session/event'), 0);
  assert.equal(harness.ctx.listenerCount('session/disposed'), 0);
  assert.equal(harness.ctx.listenerCount('llm/stream'), 0);
  assert.equal(harness.ctx.listenerCount('agent/pre-step'), 0);
  await sleep(40);
  assert.equal(harness.sessionA.deriveCalls, 0, 'a disposed capture runs no queued sample');
  // Store bodies are cleared by the plugin's store.dispose(), not by the listener teardown.
  harness.store.dispose();
  assert.equal(harness.store.getLatest('session-a', 'session_surface'), null);
  harness.capture.dispose();
});

test('request observation and agent pre-step can be disabled by config', async () => {
  const harness = makeHarness({ config: { requestObservation: false, agentPreStep: false, autoSampleSurface: false } });
  const dispose = harness.capture.install();
  assert.equal(harness.ctx.listenerCount('llm/stream'), 0);
  assert.equal(harness.ctx.listenerCount('agent/pre-step'), 0, 'disabled stages bind no listener');
  harness.ctx.emit('session/event', harness.sessionA, surfaceEvent(harness.sessionA, 2));
  await sleep(30);
  assert.equal(harness.sessionA.deriveCalls, 0, 'auto sampling is disabled');
  dispose();
  harness.capture.dispose();
});

test('default projection module is wired when no projector is injected', async () => {
  const sessions = new Map([['session-a', new FakeSession('session-a', { messages: [userMessage('msg-real-1', 'real projection text')] })]]);
  const ctx = createFakeCtx(sessions);
  const store = createObservationStore({ limits: LIMITS, clock: fixedClock });
  const capture = createCapture({
    host: createRc5Host(ctx),
    access: createAccessRegistry({ registry: registryFor(['session-a']) }),
    store,
    redactor: fakeRedactor(),
    policy: { redactionPolicyRevision: 'REDACT-1' },
    clock: fixedClock,
    limits: LIMITS,
    config: { autoSampleSurface: true, requestObservation: true, agentPreStep: true, coalesceWindowMs: 100, maxRefreshHz: 10 },
    logger: ctx.logger,
  });
  const result = await capture.captureSurface({ binding: bindingFor('session-a'), stage: 'session_surface' });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(validateObservation(result.observation).ok, true, JSON.stringify(validateObservation(result.observation).errors));
  assert.match(result.observation.observed_digest, /^[0-9a-f]{64}$/);
  assert.ok(result.observation.groups.length >= 1);
  const text = await capture.readGroupTexts({ binding: bindingFor('session-a'), observation: result.observation });
  assert.equal(text.status, 'ok');
  assert.ok(text.groups.size >= 1);
  capture.dispose();
});
