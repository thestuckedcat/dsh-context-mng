/**
 * 07 context-mng: read-only capture layer.
 *
 * Turns the rc.5 Host seams (src/host-rc5.mjs) into bounded, redacted
 * `ContextObservationV1` snapshots and keeps the two request-observation
 * invariants from docs/software-design.md §5–§6:
 *
 *  1. access is resolved through the trusted registry BEFORE any message
 *     content is read; an unbound/revoked/stale binding never reaches
 *     `deriveMessages()` or the request `options.messages`;
 *  2. the plugin is a transparent observer: it never modifies prompts,
 *     messages, tool definitions, stream chunks or `llm/stream` options, never
 *     buffers the whole stream, calls `next()` exactly once and lets every
 *     main-request error propagate. Sampling failures only drop the plugin's
 *     own observation.
 *
 * Surface sampling reads the boundary before and after `deriveMessages()` and
 * discards a sample that raced with a session append, retrying once exactly.
 * Background event sampling is coalesced (default 100 ms window, max 10 Hz)
 * and at most one sampling runs per session.
 */

import {
  LIMITS,
  canonicalJson,
  isNonEmptyString,
  isPlainObject,
  isSafeCount,
  sha256Hex,
} from './contracts.mjs';
import { fitObservationSnapshot } from './observations.mjs';
import * as defaultProjection from './projection.mjs';

const ROUTE_UNOBSERVED = 'route:unobserved';
const CAPTURE_DEFAULTS = Object.freeze({
  autoSampleSurface: true,
  requestObservation: true,
  agentPreStep: true,
  coalesceWindowMs: 100,
  maxRefreshHz: 10,
});

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function truncateId(value, maximum = 128) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum);
}

function safeUsageCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * @param {{
 *   host: object,
 *   access: object,
 *   store: object,
 *   redactor: {policyRevision?: string, redactText?: Function},
 *   policy: {redactionPolicyRevision: string},
 *   clock: () => Date,
 *   limits: object,
 *   config: object,
 *   logger: object,
 *   projector?: {projectMessages: Function, collectGroupTexts: Function, computeObservedDigest?: Function},
 * }} deps
 */
export function createCapture({
  host,
  access,
  store,
  redactor,
  policy,
  clock,
  limits = LIMITS,
  config = {},
  logger = null,
  projector = defaultProjection,
}) {
  if (host === null || typeof host !== 'object' || typeof host.readSurface !== 'function' || typeof host.readBoundary !== 'function') {
    throw new TypeError('createCapture requires a rc.5 host adapter');
  }
  if (access === null || typeof access !== 'object' || typeof access.bindingForSession !== 'function') {
    throw new TypeError('createCapture requires the trusted access registry');
  }
  if (store === null || typeof store !== 'object' || typeof store.put !== 'function' || typeof store.invalidateSession !== 'function') {
    throw new TypeError('createCapture requires the bounded observation store');
  }
  if (projector === null || typeof projector !== 'object'
    || typeof projector.projectMessages !== 'function'
    || typeof projector.collectGroupTexts !== 'function') {
    throw new TypeError('createCapture requires the projection module');
  }
  const budget = { ...LIMITS, ...(isPlainObject(limits) ? limits : {}) };
  const cfg = { ...CAPTURE_DEFAULTS, ...(isPlainObject(config) ? config : {}) };
  const redactionPolicyRevision = truncateId(policy?.redactionPolicyRevision) ?? 'REDACT-1';
  const projectPolicy = redactor === undefined || redactor === null
    ? { redactionPolicyRevision }
    : { redactionPolicyRevision, redactor };
  const coalesceWindowMs = clampInteger(cfg.coalesceWindowMs, LIMITS.coalesceWindowMsMin, LIMITS.coalesceWindowMsMax, CAPTURE_DEFAULTS.coalesceWindowMs);
  const maxRefreshHz = clampInteger(cfg.maxRefreshHz, LIMITS.maxRefreshHzMin, LIMITS.maxRefreshHzMax, CAPTURE_DEFAULTS.maxRefreshHz);
  const minSampleIntervalMs = Math.max(1, Math.ceil(1000 / maxRefreshHz));

  const counters = {
    surface_samples: 0,
    surface_stale: 0,
    surface_unavailable: 0,
    surface_denied: 0,
    request_observations: 0,
    request_failures: 0,
    pre_step_tags: 0,
    pre_step_unbound: 0,
    coalesced_events: 0,
    observer_failures: 0,
  };
  /** @type {Map<string, Promise<object>>} single in-flight sample per session */
  const inFlight = new Map();
  /** @type {Map<string, {timer: any, dirty: boolean, running: boolean, lastSampleAt: number}>} */
  const pending = new Map();
  /** @type {Map<string, number>} invalidated-surface generation per session */
  const epochs = new Map();
  let installed = false;
  let installedDispose = null;
  let requestSequence = 0;
  let lastStage = null;
  let lastRequestRef = null;
  let lastErrorCode = null;
  let lastPreStep = null;

  function report(level, code) {
    lastErrorCode = code;
    try {
      const sink = logger?.[level] ?? logger?.warn;
      if (typeof sink === 'function') sink.call(logger, `context-mng: capture ${code}`);
    } catch {
      // Diagnostics must never affect the Host request path.
    }
  }

  function note(status) {
    if (status === 'stale') counters.surface_stale += 1;
    else if (status === 'unavailable') counters.surface_unavailable += 1;
    else if (status === 'denied') counters.surface_denied += 1;
  }

  // -------------------------------------------------------------------------
  // trusted binding re-checks (always before content reads)
  // -------------------------------------------------------------------------

  function recheckBinding(binding) {
    if (binding === null || typeof binding !== 'object'
      || !isNonEmptyString(binding.session_ref)
      || !isPlainObject(binding.scope)
      || !isSafeCount(binding.scope.generation)) {
      return { ok: false, failure: { status: 'denied', reasonCode: 'CONTEXT_UNBOUND' } };
    }
    let current;
    try {
      current = access.bindingForSession(binding.session_ref);
    } catch {
      return { ok: false, failure: { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' } };
    }
    if (current === null || current === undefined) {
      return { ok: false, failure: { status: 'denied', reasonCode: 'CONTEXT_UNBOUND' } };
    }
    if (current.active !== true || current.read !== true) {
      return { ok: false, failure: { status: 'denied', reasonCode: 'SCOPE_REVOKED' } };
    }
    if (current.context_ref !== binding.context_ref) {
      return { ok: false, failure: { status: 'denied', reasonCode: 'CONTEXT_UNBOUND' } };
    }
    if (current.scope.generation !== binding.scope.generation) {
      return { ok: false, failure: { status: 'stale', reasonCode: 'STALE_SCOPE' } };
    }
    if (current.scope.scope_id !== binding.scope.scope_id
      || current.scope.identity_digest !== binding.scope.identity_digest) {
      return { ok: false, failure: { status: 'stale', reasonCode: 'STALE_SCOPE' } };
    }
    return { ok: true, binding: current };
  }

  function epochOf(sessionRef) {
    return epochs.get(sessionRef) ?? 0;
  }

  function bumpEpoch(sessionRef) {
    epochs.set(sessionRef, epochOf(sessionRef) + 1);
  }

  function makeBoundary(binding, fields, routeRevision = ROUTE_UNOBSERVED) {
    return {
      session_ref: binding.session_ref,
      scope: {
        scope_id: binding.scope.scope_id,
        generation: binding.scope.generation,
        identity_digest: binding.scope.identity_digest,
      },
      last_event_seq: fields.last_event_seq,
      surface_generation: fields.surface_generation,
      route_revision: truncateId(routeRevision) ?? ROUTE_UNOBSERVED,
      observation_epoch: epochOf(binding.session_ref),
    };
  }

  function sameBoundaryFields(left, right) {
    return left.last_event_seq === right.last_event_seq
      && left.surface_generation === right.surface_generation;
  }

  function boundaryStillCurrent(binding, currentFields, observationBoundary) {
    if (observationBoundary === null || typeof observationBoundary !== 'object') return false;
    if (observationBoundary.session_ref !== binding.session_ref) return false;
    if (observationBoundary.last_event_seq !== currentFields.last_event_seq) return false;
    if (observationBoundary.surface_generation !== currentFields.surface_generation) return false;
    const scope = observationBoundary.scope;
    return scope !== null && typeof scope === 'object'
      && scope.scope_id === binding.scope.scope_id
      && scope.generation === binding.scope.generation
      && scope.identity_digest === binding.scope.identity_digest;
  }

  // -------------------------------------------------------------------------
  // projection and observation assembly
  // -------------------------------------------------------------------------

  function projectSurface(surface) {
    try {
      const projected = projector.projectMessages({
        messages: surface.messages,
        tool_definitions: surface.tool_definitions,
        policy: projectPolicy,
        limits: budget,
      });
      if (projected === null || typeof projected !== 'object'
        || !Array.isArray(projected.groups)
        || projected.estimate === null || typeof projected.estimate !== 'object'
        || typeof projected.observed_digest !== 'string') {
        throw new Error('invalid projection result');
      }
      return { ok: true, value: projected };
    } catch {
      counters.observer_failures += 1;
      report('warn', 'PROJECTION_FAILURE');
      return { ok: false, value: null };
    }
  }

  function digestAfterTrim(projected) {
    return (trimmed) => {
      if (typeof projector.computeObservedDigest === 'function') {
        try {
          return projector.computeObservedDigest({
            groups: trimmed.groups,
            estimate: trimmed.estimate,
            totals: projected.totals,
            truncated: trimmed.truncated,
            omitted_bytes: trimmed.omitted_bytes,
            unpriced_modalities: trimmed.estimate?.unpriced_modalities ?? [],
            redaction_total: projected.redaction_total ?? 0,
          });
        } catch {
          counters.observer_failures += 1;
          report('warn', 'DIGEST_RECOMPUTE_FAILURE');
        }
      }
      return sha256Hex(canonicalJson({
        groups: trimmed.groups,
        estimate: trimmed.estimate,
        truncated: trimmed.truncated,
        omitted_bytes: trimmed.omitted_bytes,
      }));
    };
  }

  function observationIdFor({ sessionRef, stage, requestRef, boundary, observedDigest }) {
    const digest = sha256Hex(canonicalJson({
      session_ref: sessionRef,
      stage,
      request_ref: requestRef,
      last_event_seq: boundary.last_event_seq,
      surface_generation: boundary.surface_generation,
      observation_epoch: boundary.observation_epoch,
      scope_generation: boundary.scope.generation,
      route_revision: boundary.route_revision,
      observed_digest: observedDigest,
    }));
    return `ctx-obs-${digest.slice(0, 40)}`;
  }

  function capturedAt() {
    try {
      const value = typeof clock === 'function' ? clock() : new Date();
      const date = value instanceof Date ? value : new Date(value);
      return date.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  function buildObservation({
    binding,
    stage,
    fidelity,
    boundaryFields,
    projected,
    requestRef = null,
    providerRef = null,
    modelRef = null,
    reportedUsage = null,
    routeRevision = ROUTE_UNOBSERVED,
  }) {
    const boundary = makeBoundary(binding, boundaryFields, routeRevision);
    const base = {
      schema_version: 1,
      observation_id: 'ctx-obs-pending',
      revision: 0,
      boundary,
      captured_at: capturedAt(),
      capture_stage: stage,
      fidelity,
      request_ref: requestRef,
      provider_ref: providerRef,
      model_ref: modelRef,
      observed_digest: projected.observed_digest,
      wire_verified: false,
      groups: projected.groups,
      estimate: projected.estimate,
      reported_usage: reportedUsage,
      limits: { context_window: null, max_output_tokens: null },
      truncated: projected.truncated === true,
      omitted_bytes: isSafeCount(projected.omitted_bytes) ? projected.omitted_bytes : 0,
      unavailable_reason: null,
    };
    const fitted = fitObservationSnapshot(
      base,
      budget.maxSessionSnapshotBytes,
      digestAfterTrim(projected),
    );
    const observation = fitted.observation;
    observation.observation_id = observationIdFor({
      sessionRef: binding.session_ref,
      stage,
      requestRef,
      boundary: observation.boundary,
      observedDigest: observation.observed_digest,
    });
    return observation;
  }

  function storeObservation({ binding, stage, requestRef, observation }) {
    // Re-check the trusted generation immediately before the cache write.
    const recheck = recheckBinding(binding);
    if (!recheck.ok) return recheck.failure;
    try {
      const stored = store.put({
        session_ref: binding.session_ref,
        stage,
        request_ref: requestRef,
        boundary: observation.boundary,
        observation,
      });
      return { status: 'ok', observation: stored.observation };
    } catch (error) {
      counters.observer_failures += 1;
      report('warn', 'STORE_WRITE_FAILURE');
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
  }

  // -------------------------------------------------------------------------
  // direct surface sampling
  // -------------------------------------------------------------------------

  async function captureSurface({ binding, stage = 'session_surface' } = {}) {
    const checked = recheckBinding(binding);
    if (!checked.ok) {
      note(checked.failure.status);
      return checked.failure;
    }
    if (stage !== 'session_surface') {
      // Request-stage observations are pushed by the transparent middleware;
      // they are never fabricated on demand.
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    const sessionRef = binding.session_ref;
    if (typeof host.isSessionLive === 'function' && !host.isSessionLive(sessionRef)) {
      note('unavailable');
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    const running = inFlight.get(sessionRef);
    if (running !== undefined) return running;

    const promise = sampleSurface(checked.binding).catch(() => {
      counters.observer_failures += 1;
      report('warn', 'SURFACE_SAMPLE_FAILURE');
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    });
    inFlight.set(sessionRef, promise);
    try {
      return await promise;
    } finally {
      if (inFlight.get(sessionRef) === promise) inFlight.delete(sessionRef);
    }
  }

  async function sampleSurface(binding) {
    const sessionRef = binding.session_ref;
    let session;
    try {
      session = host.sessions.get(sessionRef);
    } catch {
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    if (session === null || session === undefined) {
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }

    let stable = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let before;
      let surface;
      let after;
      try {
        before = host.readBoundary(session); // metadata only, no content read
        surface = host.readSurface(session); // deriveMessages() + boundary metadata
        after = host.readBoundary(session);
      } catch {
        counters.observer_failures += 1;
        report('warn', 'SURFACE_READ_FAILURE');
        return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
      }
      if (sameBoundaryFields(before, after)
        && surface.last_event_seq === after.last_event_seq
        && surface.surface_generation === after.surface_generation) {
        stable = { surface, fields: after };
        break;
      }
      // The session changed while deriving: discard and retry once.
    }
    if (stable === null) {
      note('stale');
      return { status: 'stale', reasonCode: 'STALE_OBSERVATION' };
    }

    const projected = projectSurface(stable.surface);
    if (!projected.ok) return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    const observation = buildObservation({
      binding,
      stage: 'session_surface',
      fidelity: 'history_projection',
      boundaryFields: stable.fields,
      projected: projected.value,
    });
    const result = storeObservation({ binding, stage: 'session_surface', requestRef: null, observation });
    if (result.status === 'ok') {
      counters.surface_samples += 1;
      lastStage = 'session_surface';
    } else {
      note(result.status);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // request observations from the transparent llm/stream middleware
  // -------------------------------------------------------------------------

  function handleLlmStream(options, guardedNext) {
    if (!installed || cfg.requestObservation === false) return guardedNext();
    let sessionId = null;
    try {
      sessionId = options !== null && typeof options === 'object' ? options.sessionId : null;
    } catch {
      sessionId = null;
    }
    // Access is resolved before touching any request content.
    let binding = null;
    if (typeof sessionId === 'string') {
      try {
        binding = access.bindingForSession(sessionId);
      } catch {
        binding = null;
      }
    }
    if (binding === null || binding === undefined || binding.active !== true || binding.read !== true) {
      return guardedNext();
    }

    // Metadata-only boundary read: the session surface the request starts from.
    let boundaryFields = { last_event_seq: 0, surface_generation: 0 };
    let sessionAvailable = false;
    try {
      const session = host.sessions.get(sessionId);
      if (session !== null && session !== undefined) {
        boundaryFields = host.readBoundary(session);
        sessionAvailable = true;
      }
    } catch {
      sessionAvailable = false;
    }
    requestSequence += 1;
    const requestRef = truncateId(`ctx-req-${requestSequence}-${sessionId}-g${binding.scope.generation}`) ?? `ctx-req-${requestSequence}`;
    lastRequestRef = requestRef;

    const downstream = guardedNext();
    if (downstream === null || downstream === undefined || typeof downstream[Symbol.asyncIterator] !== 'function') {
      return downstream;
    }
    return observeLlmStream({
      downstream,
      binding,
      requestRef,
      options,
      boundaryFields,
      sessionAvailable,
    });
  }

  async function* observeLlmStream({ downstream, binding, requestRef, options, boundaryFields, sessionAvailable }) {
    let usage = null;
    let finishSeen = false;
    let completed = false;
    try {
      for await (const chunk of downstream) {
        if (chunk !== null && typeof chunk === 'object') {
          try {
            if (chunk.type === 'usage') usage = normalizeUsage(chunk.usage);
            else if (chunk.type === 'finish') finishSeen = true;
          } catch {
            counters.observer_failures += 1;
          }
        }
        yield chunk;
      }
      completed = true;
    } finally {
      try {
        recordRequestObservation({
          binding,
          requestRef,
          options,
          boundaryFields,
          sessionAvailable,
          usage,
          finishSeen,
          completed,
        });
      } catch {
        counters.observer_failures += 1;
        report('warn', 'REQUEST_OBSERVATION_FAILURE');
      }
    }
  }

  function normalizeUsage(rawUsage) {
    if (rawUsage === null || typeof rawUsage !== 'object') return null;
    return {
      input_tokens: safeUsageCount(rawUsage.inputTokens),
      output_tokens: safeUsageCount(rawUsage.outputTokens),
      cached_input_tokens: safeUsageCount(rawUsage.cacheReadTokens),
    };
  }

  function recordRequestObservation({ binding, requestRef, options, boundaryFields, sessionAvailable, usage, completed }) {
    if (!sessionAvailable) {
      counters.request_failures += 1;
      return;
    }
    const messages = Array.isArray(options?.messages) ? options.messages : [];
    const toolDefinitions = Array.isArray(options?.tools) ? options.tools : [];
    const projected = projectSurface({ messages, tool_definitions: toolDefinitions });
    if (!projected.ok) {
      counters.request_failures += 1;
      return;
    }
    const providerRef = truncateId(options?.provider);
    const modelRef = truncateId(options?.model);
    const routeRevision = providerRef !== null && modelRef !== null
      ? `route:${providerRef}/${modelRef}`
      : ROUTE_UNOBSERVED;
    const aborted = options?.signal?.aborted === true;
    const reportedUsage = usage === null ? null : {
      request_ref: requestRef,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_input_tokens: usage.cached_input_tokens,
      source: 'provider_usage_chunk',
      // Late usage after cancellation belongs to the original request but can
      // never be presented as the final provider accounting.
      is_final: completed === true && aborted === false,
    };
    const observation = buildObservation({
      binding,
      stage: 'llm_waterfall',
      fidelity: 'request_observed',
      boundaryFields,
      projected: projected.value,
      requestRef,
      providerRef,
      modelRef,
      reportedUsage,
      routeRevision,
    });
    const result = storeObservation({ binding, stage: 'llm_waterfall', requestRef, observation });
    if (result.status === 'ok') {
      counters.request_observations += 1;
      lastStage = 'llm_waterfall';
    } else {
      counters.request_failures += 1;
    }
  }

  // -------------------------------------------------------------------------
  // agent/pre-step stage tagging (observation only, never a decision)
  // -------------------------------------------------------------------------

  function handleAgentPreStep(payload) {
    if (!installed || cfg.agentPreStep === false) return;
    try {
      const session = payload?.agent?.session ?? null;
      const sessionId = session !== null && typeof session === 'object' && typeof session.id === 'string'
        ? session.id
        : null;
      if (sessionId === null) {
        counters.pre_step_unbound += 1;
        return;
      }
      // Access is resolved before any payload content is inspected.
      let binding = null;
      try {
        binding = access.bindingForSession(sessionId);
      } catch {
        binding = null;
      }
      if (binding === null || binding === undefined || binding.active !== true || binding.read !== true) {
        counters.pre_step_unbound += 1;
        return;
      }
      counters.pre_step_tags += 1;
      lastStage = 'agent_pre_step';
      lastPreStep = {
        session_ref: sessionId,
        turn: isSafeCount(payload?.turn) ? payload.turn : null,
        step: isSafeCount(payload?.step) ? payload.step : null,
      };
    } catch {
      counters.observer_failures += 1;
      report('warn', 'PRE_STEP_TAG_FAILURE');
    }
  }

  // -------------------------------------------------------------------------
  // coalesced background sampling
  // -------------------------------------------------------------------------

  function scheduleSample(binding) {
    const sessionRef = binding.session_ref;
    let state = pending.get(sessionRef);
    if (state === undefined) {
      state = { timer: null, dirty: false, running: false, lastSampleAt: 0 };
      pending.set(sessionRef, state);
    }
    if (state.running || state.timer !== null) {
      state.dirty = true;
      counters.coalesced_events += 1;
      return;
    }
    const elapsed = Date.now() - state.lastSampleAt;
    const delay = Math.max(coalesceWindowMs, minSampleIntervalMs - elapsed, 0);
    state.timer = setTimeout(() => {
      const current = pending.get(sessionRef);
      if (current === undefined || !installed) return;
      current.timer = null;
      runScheduledSample(sessionRef, binding);
    }, delay);
    state.timer?.unref?.();
  }

  async function runScheduledSample(sessionRef, binding) {
    const state = pending.get(sessionRef);
    if (state === undefined || !installed) return;
    state.running = true;
    state.lastSampleAt = Date.now();
    try {
      await captureSurface({ binding, stage: 'session_surface' });
    } catch {
      counters.observer_failures += 1;
      report('warn', 'BACKGROUND_SAMPLE_FAILURE');
    } finally {
      state.running = false;
      if (!installed) {
        pending.delete(sessionRef);
        return;
      }
      if (state.dirty) {
        state.dirty = false;
        scheduleSample(binding);
      } else {
        pending.delete(sessionRef);
      }
    }
  }

  function cancelScheduled(sessionRef) {
    const state = pending.get(sessionRef);
    if (state === undefined) return;
    if (state.timer !== null) clearTimeout(state.timer);
    pending.delete(sessionRef);
  }

  function handleSessionEvent(notification) {
    if (!installed) return;
    try {
      const session = notification?.session;
      if (session === null || typeof session !== 'object' || typeof session.id !== 'string') return;
      const sessionRef = session.id;
      if (notification.kind === 'disposed') {
        // Removing a session never needs a content read: clear immediately.
        store.invalidateSession(sessionRef);
        bumpEpoch(sessionRef);
        cancelScheduled(sessionRef);
        return;
      }
      // Trusted access BEFORE reading any event content (e.g. event.data).
      let binding = null;
      try {
        binding = access.bindingForSession(sessionRef);
      } catch {
        binding = null;
      }
      if (binding === null || binding === undefined || binding.active !== true || binding.read !== true) return;
      if (cfg.autoSampleSurface === false) return;
      const event = notification.event;
      if (event === null || typeof event !== 'object' || event.surfaceOp === undefined) return;
      if (event.surfaceOp !== 'append') {
        // Replacement / rewind: invalidate first, then re-read the live surface.
        store.invalidateSession(sessionRef);
        bumpEpoch(sessionRef);
      }
      scheduleSample(binding);
    } catch {
      counters.observer_failures += 1;
      report('warn', 'SESSION_EVENT_HANDLER_FAILURE');
    }
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  function install() {
    if (installed) return installedDispose;
    const disposers = [];
    try {
      disposers.push(host.onSessionEvent(handleSessionEvent));
      if (cfg.requestObservation !== false) disposers.push(host.onLlmStream(handleLlmStream));
      if (cfg.agentPreStep !== false) disposers.push(host.onAgentPreStep(handleAgentPreStep));
    } catch (error) {
      while (disposers.length > 0) {
        try { disposers.pop()(); } catch { /* already detached */ }
      }
      throw error;
    }
    installed = true;
    installedDispose = () => {
      if (!installed) return;
      installed = false;
      while (disposers.length > 0) {
        try { disposers.pop()(); } catch { /* already detached */ }
      }
      for (const state of pending.values()) {
        if (state.timer !== null) clearTimeout(state.timer);
      }
      pending.clear();
      inFlight.clear();
    };
    return installedDispose;
  }

  function describe() {
    return {
      installed,
      config: {
        autoSampleSurface: cfg.autoSampleSurface !== false,
        requestObservation: cfg.requestObservation !== false,
        agentPreStep: cfg.agentPreStep !== false,
        coalesceWindowMs,
        maxRefreshHz,
      },
      counters: { ...counters },
      pre_step_tags: counters.pre_step_tags,
      pre_step_last: lastPreStep === null ? null : { ...lastPreStep },
      last_stage: lastStage,
      last_request_ref: lastRequestRef,
      last_error_code: lastErrorCode,
      in_flight_sessions: inFlight.size,
      pending_sessions: pending.size,
    };
  }

  function dispose() {
    if (installedDispose !== null) installedDispose();
    for (const state of pending.values()) {
      if (state.timer !== null) clearTimeout(state.timer);
    }
    pending.clear();
    inFlight.clear();
    epochs.clear();
  }

  // -------------------------------------------------------------------------
  // read-back of one group's redacted full text
  // -------------------------------------------------------------------------

  async function readGroupTexts({ binding, observation } = {}) {
    const checked = recheckBinding(binding);
    if (!checked.ok) return checked.failure;
    if (observation === null || typeof observation !== 'object'
      || observation.boundary === null || typeof observation.boundary !== 'object'
      || observation.boundary.session_ref !== binding.session_ref
      || !Array.isArray(observation.groups)) {
      return { status: 'stale', reasonCode: 'STALE_OBSERVATION' };
    }
    const sessionRef = binding.session_ref;
    if (typeof host.isSessionLive === 'function' && !host.isSessionLive(sessionRef)) {
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    let session;
    try {
      session = host.sessions.get(sessionRef);
    } catch {
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    if (session === null || session === undefined) {
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    let before;
    let surface;
    let after;
    try {
      before = host.readBoundary(session);
      surface = host.readSurface(session);
      after = host.readBoundary(session);
    } catch {
      counters.observer_failures += 1;
      report('warn', 'GROUP_READ_FAILURE');
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    if (!sameBoundaryFields(before, after) || !boundaryStillCurrent(checked.binding, after, observation.boundary)) {
      return { status: 'stale', reasonCode: 'STALE_OBSERVATION' };
    }
    const recheck = recheckBinding(binding);
    if (!recheck.ok) return recheck.failure;
    let collected;
    try {
      collected = projector.collectGroupTexts({
        messages: surface.messages,
        tool_definitions: surface.tool_definitions,
        policy: projectPolicy,
        limits: budget,
      });
    } catch {
      counters.observer_failures += 1;
      report('warn', 'GROUP_COLLECT_FAILURE');
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    if (collected === null || typeof collected !== 'object' || !(collected.groups instanceof Map)) {
      return { status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' };
    }
    const expected = observation.groups.map((group) => group.group_id).sort().join('\u0000');
    const current = [...collected.groups.keys()].sort().join('\u0000');
    if (expected !== current) {
      return { status: 'stale', reasonCode: 'STALE_OBSERVATION' };
    }
    return { status: 'ok', groups: collected.groups, truncated: collected.truncated === true };
  }

  return {
    captureSurface,
    readGroupTexts,
    install,
    describe,
    dispose,
  };
}
