/**
 * 07 context-mng: browser-side panel store.
 *
 * This module is the single browser source for request correlation. It is
 * written as plain ES2019 (no JSX, no imports, no bundler) because the rc.5
 * client bundle format has no relative-module resolution: `client.js` embeds
 * this file verbatim between markers and `tests/client-contract.test.mjs`
 * verifies the embedded copy is byte-identical to this source.
 *
 * Rules implemented here (design §5.1, §6):
 *  - every view has an epoch; switching session/stage, closing the panel,
 *    revoking a scope and disposing all abort the in-flight request, increment
 *    the epoch and clear previously displayed body text;
 *  - a response whose epoch/generation/operation_id does not match the request
 *    that is still current is dropped without touching what the user sees;
 *  - at most one `observation.get` poll is in flight; the 500 ms poll only runs
 *    while the panel is mounted, the document is visible and refresh is not
 *    paused;
 *  - the data path is the rc.5 exact Fetch route (CTX-RPC-03): one same-origin
 *    `POST /api/context-mng/<endpoint>` per request, JSON body, browser cookies
 *    authenticating the shared owner Peer. A non-2xx response, unparseable
 *    JSON or an invalid BusinessResponse maps to the fixed code
 *    `TRANSPORT_FAILURE`; raw messages/details are never copied into state
 *    (nothing raw can reach the DOM);
 *  - writes (report.export) are user-triggered only and never auto-retried.
 */

const API_BASE = '/api/context-mng';
const ENDPOINTS = ['context.list', 'observation.get', 'group.read', 'report.export'];

const BUSINESS_STATUSES = ['ok', 'denied', 'stale', 'unavailable', 'invalid', 'failed'];
const REASON_CODES = [
  'OWNER_REQUIRED',
  'CONTEXT_UNBOUND',
  'SCOPE_REVOKED',
  'STALE_SCOPE',
  'STALE_OBSERVATION',
  'SESSION_UNAVAILABLE',
  'INVALID_REQUEST',
  'LIMIT_EXCEEDED',
  'UNKNOWN_ENDPOINT',
  'OUTPUT_REF_DENIED',
  'EXPORT_CONFLICT',
  'OUTCOME_UNKNOWN',
  'INTERNAL_FAILURE',
];
const POLL_INTERVAL_MS = 500;
const GROUP_PAGE_LIMIT = 8192;
const STAGES = ['session_surface', 'agent_pre_step', 'llm_waterfall'];
const FIDELITIES = ['history_projection', 'request_observed', 'unavailable'];
const CATEGORIES = ['system', 'developer', 'user', 'assistant', 'tools', 'tool_result', 'memory', 'unknown'];
const CERTAINTIES = ['identified', 'heuristic', 'unknown'];
const TRANSPORT_FAILURE = 'TRANSPORT_FAILURE';
const STALE_RESPONSE = 'STALE_RESPONSE';
const ABORTED = 'ABORTED';
const OBSERVATION_FIELDS = [
  'schema_version', 'observation_id', 'revision', 'boundary', 'captured_at', 'capture_stage',
  'fidelity', 'request_ref', 'provider_ref', 'model_ref', 'observed_digest', 'wire_verified',
  'groups', 'estimate', 'reported_usage', 'limits', 'truncated', 'omitted_bytes', 'unavailable_reason',
];
const GROUP_FIELDS = [
  'group_id', 'category', 'source_ref', 'source_kind', 'message_refs', 'characters', 'bytes',
  'estimated_tokens', 'certainty', 'preview', 'truncated', 'redaction_count',
];

function isPlainObject(value) {
  // Accept plain objects from any realm: wire data may come from JSON.parse in
  // another context (structured clone / iframe), where the prototype identity
  // differs even though the shape is a plain record.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value, max) {
  const limit = max === undefined ? 128 : max;
  return typeof value === 'string' && value.length >= 1 && value.length <= limit;
}

function isNullableString(value) {
  return value === null || isBoundedString(value);
}

function onlyKnownFields(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (allowed.indexOf(key) === -1) errors.push(path + '.' + key);
  }
}

/** Strict BusinessResponse check: unknown fields and unregistered codes are refused. */
export function validateBusinessResponseLite(value) {
  const allowed = ['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status', 'data', 'reason_code'];
  if (!isPlainObject(value)) return { ok: false, errors: ['response must be an object'] };
  const errors = [];
  onlyKnownFields(value, allowed, 'response', errors);
  if (value.schema_version !== 1) errors.push('response.schema_version');
  if (!isBoundedString(value.operation_id)) errors.push('response.operation_id');
  if (!isCount(value.view_epoch)) errors.push('response.view_epoch');
  if (!isCount(value.scope_generation)) errors.push('response.scope_generation');
  if (BUSINESS_STATUSES.indexOf(value.status) === -1) errors.push('response.status');
  if (value.status === 'ok') {
    if (value.data === undefined) errors.push('response.data');
    if (Object.prototype.hasOwnProperty.call(value, 'reason_code')) errors.push('response.reason_code');
  } else {
    if (REASON_CODES.indexOf(value.reason_code) === -1) errors.push('response.reason_code');
    if (value.data !== undefined) errors.push('response.data');
  }
  return { ok: errors.length === 0, errors };
}

/** Structural check of one ContextObservationV1 before it is displayed. */
export function validateObservationLite(value) {
  if (!isPlainObject(value)) return { ok: false, errors: ['observation must be an object'] };
  const errors = [];
  onlyKnownFields(value, OBSERVATION_FIELDS, 'observation', errors);
  if (value.schema_version !== 1) errors.push('observation.schema_version');
  if (!isBoundedString(value.observation_id)) errors.push('observation.observation_id');
  if (!isCount(value.revision)) errors.push('observation.revision');
  if (!isPlainObject(value.boundary)) {
    errors.push('observation.boundary');
  } else {
    if (!isBoundedString(value.boundary.session_ref)) errors.push('observation.boundary.session_ref');
    if (!isPlainObject(value.boundary.scope) || !isCount(value.boundary.scope.generation)) errors.push('observation.boundary.scope');
  }
  if (typeof value.captured_at !== 'string') errors.push('observation.captured_at');
  if (STAGES.indexOf(value.capture_stage) === -1) errors.push('observation.capture_stage');
  if (FIDELITIES.indexOf(value.fidelity) === -1) errors.push('observation.fidelity');
  for (const field of ['request_ref', 'provider_ref', 'model_ref', 'unavailable_reason']) {
    if (!isNullableString(value[field])) errors.push('observation.' + field);
  }
  if (value.wire_verified !== false) errors.push('observation.wire_verified');
  if (!Array.isArray(value.groups)) {
    errors.push('observation.groups');
  } else {
    for (const group of value.groups) {
      if (!isPlainObject(group)) {
        errors.push('observation.groups[]');
        continue;
      }
      onlyKnownFields(group, GROUP_FIELDS, 'group', errors);
      if (!isBoundedString(group.group_id)) errors.push('group.group_id');
      if (CATEGORIES.indexOf(group.category) === -1) errors.push('group.category');
      if (!isCount(group.characters) || !isCount(group.bytes) || !isCount(group.redaction_count)) errors.push('group.counts');
      if (group.estimated_tokens !== null && !isCount(group.estimated_tokens)) errors.push('group.estimated_tokens');
      if (CERTAINTIES.indexOf(group.certainty) === -1) errors.push('group.certainty');
      if (typeof group.preview !== 'string') errors.push('group.preview');
      if (typeof group.truncated !== 'boolean') errors.push('group.truncated');
    }
  }
  if (!isPlainObject(value.estimate) || typeof value.estimate.method !== 'string') errors.push('observation.estimate');
  if (!isPlainObject(value.limits)) errors.push('observation.limits');
  if (typeof value.truncated !== 'boolean') errors.push('observation.truncated');
  if (!isCount(value.omitted_bytes)) errors.push('observation.omitted_bytes');
  return { ok: errors.length === 0, errors };
}

function normalizeContextEntry(raw) {
  if (!isPlainObject(raw)) return null;
  if (!isBoundedString(raw.context_ref) || !isBoundedString(raw.session_ref)) return null;
  const scope = isPlainObject(raw.scope) ? raw.scope : raw;
  const scopeId = isBoundedString(scope.scope_id) ? scope.scope_id : (isBoundedString(raw.scope_id) ? raw.scope_id : '');
  const generation = isCount(scope.generation) ? scope.generation : (isCount(raw.generation) ? raw.generation : null);
  if (raw.read !== true || generation === null) return null;
  const exportRoots = Array.isArray(raw.export_root_refs)
    ? raw.export_root_refs.filter((ref) => isBoundedString(ref)).slice(0, 8)
    : [];
  return {
    context_ref: raw.context_ref,
    session_ref: raw.session_ref,
    scope_id: scopeId,
    generation,
    read: true,
    export_root_refs: exportRoots,
  };
}

function defaultOperationId() {
  if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
    return 'ctx-' + crypto.randomUUID();
  }
  return 'ctx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * @param {{
 *   rpc: {call: Function},
 *   apiBase?: string,
 *   pollIntervalMs?: number,
 *   document?: {visibilityState?: string, addEventListener?: Function, removeEventListener?: Function},
 *   timers?: {setInterval: Function, clearInterval: Function},
 *   operationId?: () => string,
 *   initialStage?: string,
 * }} options
 */
export function createContextStore(options) {
  const settings = options || {};
  if (!settings.fetch || typeof settings.fetch !== 'function') {
    throw new TypeError('createContextStore requires a fetch caller for the exact Host route');
  }
  const fetchImpl = settings.fetch;
  const apiBase = typeof settings.apiBase === 'string' && settings.apiBase.length > 0 ? settings.apiBase : API_BASE;
  const pollIntervalMs = isCount(settings.pollIntervalMs) && settings.pollIntervalMs > 0 ? settings.pollIntervalMs : POLL_INTERVAL_MS;
  const doc = settings.document === undefined || settings.document === null ? undefined : settings.document;
  const timers = settings.timers || (typeof globalThis === 'undefined' ? undefined : globalThis);
  const operationIdFactory = typeof settings.operationId === 'function' ? settings.operationId : defaultOperationId;
  const initialStage = STAGES.indexOf(settings.initialStage) === -1 ? 'session_surface' : settings.initialStage;

  let epoch = 0;
  let disposed = false;
  let pollTimer;
  let pollInFlightEpoch = null;
  let bootstrappingEpoch = null;
  let exporting = false;
  let operationCounter = 0;
  const controllers = new Set();
  const listeners = new Set();
  const idleWaiters = [];
  const readingGroups = {};
  let pendingRequests = 0;

  let snapshot = Object.freeze({
    disposed: false,
    status: 'idle',
    error_code: null,
    reason_code: null,
    session_ref: null,
    contexts: [],
    context: null,
    stage: initialStage,
    observation: null,
    observation_id: null,
    revision: 0,
    changed: false,
    groups: [],
    group_texts: {},
    expanded: {},
    estimate: null,
    reported_usage: null,
    limits: null,
    truncated: false,
    omitted_bytes: 0,
    observed_at: null,
    fidelity: null,
    capture_stage: initialStage,
    export_roots: [],
    export_state: { phase: 'idle', report_ref: null, digest: null, reason_code: null },
    paused: false,
    panel_active: false,
    visible: readVisibility(doc),
  });

  function readVisibility(target) {
    if (target === undefined) return true;
    return target.visibilityState !== 'hidden';
  }

  function getSnapshot() {
    return snapshot;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify() {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        /* a subscriber crash must not break the store */
      }
    }
    if (pendingRequests === 0 && idleWaiters.length > 0) {
      const waiters = idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  function update(patch) {
    snapshot = Object.freeze(Object.assign({}, snapshot, patch));
    notify();
  }

  function whenIdle() {
    if (pendingRequests === 0) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  function newController() {
    const controller = new AbortController();
    controllers.add(controller);
    return controller;
  }

  function releaseController(controller) {
    controllers.delete(controller);
  }

  function abortAll() {
    for (const controller of Array.from(controllers)) {
      try {
        controller.abort();
      } catch {
        /* ignore abort failures */
      }
    }
    controllers.clear();
  }

  function bumpEpoch() {
    epoch += 1;
    abortAll();
    return epoch;
  }

  function nextOperationId() {
    operationCounter += 1;
    return operationIdFactory(operationCounter);
  }

  function listEnvelope() {
    return { schema_version: 1, operation_id: nextOperationId(), view_epoch: epoch, input: {} };
  }

  function requestEnvelope(context, input) {
    return {
      schema_version: 1,
      operation_id: nextOperationId(),
      context_ref: context.context_ref,
      expected_scope_generation: context.generation,
      view_epoch: epoch,
      input,
    };
  }

  /**
   * One same-origin exact-route POST. Resolves `{ok:true, value}` only for a
   * well-formed BusinessResponse; every HTTP/JSON/validation failure resolves
   * `{ok:false, code}` with a fixed code (never raw text).
   */
  async function callEndpoint(endpoint, payload, controller) {
    if (ENDPOINTS.indexOf(endpoint) === -1) return { ok: false, code: TRANSPORT_FAILURE };
    pendingRequests += 1;
    try {
      let response;
      try {
        response = await fetchImpl(apiBase + '/' + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        return { ok: false, code: controller.signal.aborted ? ABORTED : TRANSPORT_FAILURE };
      }
      if (controller.signal.aborted) return { ok: false, code: ABORTED };
      if (response === null || typeof response !== 'object' || response.ok !== true) {
        return { ok: false, code: TRANSPORT_FAILURE };
      }
      let value;
      try {
        value = await response.json();
      } catch {
        return { ok: false, code: controller.signal.aborted ? ABORTED : TRANSPORT_FAILURE };
      }
      if (controller.signal.aborted) return { ok: false, code: ABORTED };
      if (!validateBusinessResponseLite(value).ok) return { ok: false, code: TRANSPORT_FAILURE };
      if (value.operation_id !== payload.operation_id || value.view_epoch !== payload.view_epoch) {
        return { ok: false, code: STALE_RESPONSE };
      }
      return { ok: true, value };
    } finally {
      releaseController(controller);
      pendingRequests = Math.max(0, pendingRequests - 1);
      notify();
    }
  }

  function stopPolling() {
    if (pollTimer !== undefined && timers && typeof timers.clearInterval === 'function') {
      timers.clearInterval(pollTimer);
    }
    pollTimer = undefined;
  }

  function canPoll() {
    return !disposed && snapshot.panel_active && !snapshot.paused && snapshot.visible && snapshot.context !== null;
  }

  function startPolling() {
    if (!canPoll()) {
      stopPolling();
      return;
    }
    if (pollTimer !== undefined) return;
    pollTimer = timers.setInterval(() => {
      pollOnce().catch(() => {});
    }, pollIntervalMs);
  }

  function syncPolling() {
    if (canPoll()) startPolling();
    else stopPolling();
  }

  function visibilityChanged() {
    const visible = readVisibility(doc);
    if (visible === snapshot.visible) return;
    update({ visible });
    if (!visible) {
      stopPolling();
      return;
    }
    if (snapshot.panel_active && snapshot.context !== null && !snapshot.paused) {
      refresh().catch(() => {});
    }
  }

  function attachVisibility() {
    if (doc === undefined || typeof doc.addEventListener !== 'function') return;
    doc.addEventListener('visibilitychange', visibilityChanged);
  }

  function detachVisibility() {
    if (doc === undefined || typeof doc.removeEventListener !== 'function') return;
    doc.removeEventListener('visibilitychange', visibilityChanged);
  }

  function clearBody() {
    return {
      observation: null,
      observation_id: null,
      revision: 0,
      changed: false,
      groups: [],
      group_texts: {},
      expanded: {},
      estimate: null,
      reported_usage: null,
      limits: null,
      truncated: false,
      omitted_bytes: 0,
      observed_at: null,
      fidelity: null,
      export_state: { phase: 'idle', report_ref: null, digest: null, reason_code: null },
    };
  }

  function applyTransportFailure() {
    stopPolling();
    update({ status: 'error', error_code: TRANSPORT_FAILURE, reason_code: null });
  }

  function statusFromFailure(value) {
    if (value.status === 'denied') return { status: 'denied', reason_code: value.reason_code };
    if (value.status === 'stale') return { status: 'stale', reason_code: value.reason_code };
    if (value.status === 'unavailable') return { status: 'unavailable', reason_code: value.reason_code };
    return { status: 'error', reason_code: value.reason_code };
  }

  async function bootstrap() {
    if (disposed || bootstrappingEpoch === epoch) return;
    if (snapshot.session_ref === null) {
      update({ status: 'unbound' });
      return;
    }
    const requestEpoch = epoch;
    bootstrappingEpoch = requestEpoch;
    const controller = newController();
    update({ status: 'loading', error_code: null, reason_code: null });
    try {
      const response = await callEndpoint('context.list', listEnvelope(), controller);
      if (requestEpoch !== epoch || disposed) return;
      if (!response.ok) {
        if (response.code === ABORTED || response.code === STALE_RESPONSE) return;
        applyTransportFailure();
        return;
      }
      const value = response.value;
      if (value.status !== 'ok') {
        stopPolling();
        update(statusFromFailure(value));
        return;
      }
      const data = value.data;
      const rawContexts = isPlainObject(data) && Array.isArray(data.contexts) ? data.contexts : null;
      if (rawContexts === null) {
        applyTransportFailure();
        return;
      }
      const contexts = [];
      for (const raw of rawContexts) {
        const entry = normalizeContextEntry(raw);
        if (entry !== null) contexts.push(entry);
      }
      const selected = contexts.filter((entry) => entry.session_ref === snapshot.session_ref)[0] || null;
      if (selected === null) {
        stopPolling();
        update({ status: 'unbound', contexts, context: null, export_roots: [] });
        return;
      }
      update({
        contexts,
        context: selected,
        export_roots: selected.export_root_refs.slice(),
        status: snapshot.observation === null ? 'empty' : snapshot.status,
      });
      startPolling();
      await pollOnce();
    } finally {
      if (bootstrappingEpoch === requestEpoch) bootstrappingEpoch = null;
    }
  }

  function acceptObservation(observation) {
    const check = validateObservationLite(observation);
    if (!check.ok) return false;
    const sameObservation = snapshot.observation_id === observation.observation_id;
    update({
      status: 'ready',
      observation,
      observation_id: observation.observation_id,
      revision: observation.revision,
      groups: observation.groups,
      estimate: observation.estimate,
      reported_usage: observation.reported_usage,
      limits: observation.limits,
      truncated: observation.truncated === true,
      omitted_bytes: observation.omitted_bytes,
      observed_at: observation.captured_at,
      fidelity: observation.fidelity,
      capture_stage: observation.capture_stage,
      changed: true,
      error_code: null,
      reason_code: null,
      group_texts: sameObservation ? snapshot.group_texts : {},
      expanded: sameObservation ? snapshot.expanded : {},
    });
    return true;
  }

  async function pollOnce() {
    if (disposed || pollInFlightEpoch === epoch) return;
    const context = snapshot.context;
    if (context === null) return;
    if (!canPoll()) {
      stopPolling();
      return;
    }
    const requestEpoch = epoch;
    pollInFlightEpoch = requestEpoch;
    const controller = newController();
    const input = { stage: snapshot.stage };
    if (snapshot.observation !== null) input.after_revision = snapshot.revision;
    try {
      const response = await callEndpoint('observation.get', requestEnvelope(context, input), controller);
      if (requestEpoch !== epoch || disposed) return;
      if (!response.ok) {
        if (response.code === ABORTED || response.code === STALE_RESPONSE) return;
        applyTransportFailure();
        return;
      }
      const value = response.value;
      if (value.scope_generation !== context.generation) {
        stopPolling();
        update({ status: 'stale', reason_code: 'STALE_SCOPE' });
        return;
      }
      if (value.status !== 'ok') {
        stopPolling();
        update(statusFromFailure(value));
        return;
      }
      const data = value.data;
      if (!isPlainObject(data) || typeof data.changed !== 'boolean' || !isCount(data.current_revision)) {
        applyTransportFailure();
        return;
      }
      if (data.changed === true) {
        if (data.observation === undefined || data.observation === null) {
          applyTransportFailure();
          return;
        }
        if (!acceptObservation(data.observation)) {
          applyTransportFailure();
          return;
        }
      } else if (snapshot.observation === null) {
        update({ status: 'empty', revision: data.current_revision, error_code: null, reason_code: null });
      }
      startPolling();
    } finally {
      if (pollInFlightEpoch === requestEpoch) pollInFlightEpoch = null;
    }
  }

  async function refresh() {
    if (disposed || !snapshot.panel_active) return;
    if (snapshot.session_ref === null) {
      update({ status: 'unbound' });
      return;
    }
    if (snapshot.context === null) {
      await bootstrap();
      return;
    }
    if (snapshot.paused || !snapshot.visible) return;
    await pollOnce();
  }

  function selectSession(sessionRef) {
    if (disposed) return;
    const next = typeof sessionRef === 'string' && sessionRef.length > 0 ? sessionRef : null;
    if (next === snapshot.session_ref) return;
    bumpEpoch();
    stopPolling();
    update(Object.assign({
      status: next === null ? 'unbound' : 'loading',
      error_code: null,
      reason_code: null,
      session_ref: next,
      context: null,
      contexts: [],
      export_roots: [],
    }, clearBody()));
    if (next !== null && snapshot.panel_active && !snapshot.paused && snapshot.visible) {
      bootstrap().catch(() => {});
    }
  }

  function setPanelActive(active) {
    if (disposed) return;
    const next = active === true;
    if (next === snapshot.panel_active) return;
    if (!next) {
      bumpEpoch();
      stopPolling();
      detachVisibility();
      update(Object.assign({
        panel_active: false,
        visible: readVisibility(doc),
        status: 'idle',
        error_code: null,
        reason_code: null,
      }, clearBody()));
      return;
    }
    update({ panel_active: true, visible: readVisibility(doc) });
    attachVisibility();
    if (snapshot.session_ref !== null && !snapshot.paused && snapshot.visible) {
      if (snapshot.context === null) bootstrap().catch(() => {});
      else {
        syncPolling();
        refresh().catch(() => {});
      }
    }
  }

  function setStage(stage) {
    if (disposed) return;
    if (STAGES.indexOf(stage) === -1) return;
    if (stage === snapshot.stage) return;
    bumpEpoch();
    stopPolling();
    update(Object.assign({ stage, status: 'loading', error_code: null, reason_code: null }, clearBody()));
    if (snapshot.panel_active && !snapshot.paused && snapshot.visible) {
      if (snapshot.context === null) bootstrap().catch(() => {});
      else pollOnce().catch(() => {});
    }
  }

  function setPaused(paused) {
    if (disposed) return;
    const next = paused === true;
    if (next === snapshot.paused) return;
    update({ paused: next });
    if (next) {
      stopPolling();
      bumpEpoch();
    } else if (snapshot.panel_active && snapshot.visible) {
      refresh().catch(() => {});
    }
  }

  function setExpanded(groupId, expanded) {
    const next = Object.assign({}, snapshot.expanded);
    if (expanded) next[groupId] = true;
    else delete next[groupId];
    update({ expanded: next });
  }

  function toggleGroup(groupId) {
    if (disposed || !isBoundedString(groupId)) return;
    if (snapshot.expanded[groupId] === true) {
      setExpanded(groupId, false);
      return;
    }
    setExpanded(groupId, true);
    if (snapshot.group_texts[groupId] === undefined) {
      readGroupPage(groupId, 0, true).catch(() => {});
    }
  }

  function writeGroupTexts(groupId, entry) {
    const texts = Object.assign({}, snapshot.group_texts);
    texts[groupId] = Object.assign({}, texts[groupId] || {}, entry);
    update({ group_texts: texts });
  }

  async function readGroupPage(groupId, offset, replace) {
    if (disposed || snapshot.observation === null || readingGroups[groupId] === true) return;
    const context = snapshot.context;
    if (context === null) return;
    readingGroups[groupId] = true;
    const requestEpoch = epoch;
    const controller = newController();
    const previous = snapshot.group_texts[groupId];
    const base = previous === undefined
      ? { text: '', next_offset: null, revision: 0 }
      : { text: replace ? '' : previous.text, next_offset: previous.next_offset, revision: previous.revision };
    writeGroupTexts(groupId, { loading: true, error: null, text: base.text, next_offset: base.next_offset, revision: base.revision });
    try {
      const payload = requestEnvelope(context, {
        observation_id: snapshot.observation.observation_id,
        group_id: groupId,
        offset,
        limit: GROUP_PAGE_LIMIT,
      });
      const response = await callEndpoint('group.read', payload, controller);
      if (requestEpoch !== epoch || disposed) return;
      if (!response.ok) {
        if (response.code === ABORTED || response.code === STALE_RESPONSE) return;
        writeGroupTexts(groupId, { loading: false, error: TRANSPORT_FAILURE });
        return;
      }
      const value = response.value;
      if (value.status !== 'ok') {
        stopPolling();
        update(statusFromFailure(value));
        writeGroupTexts(groupId, { loading: false, error: null });
        return;
      }
      const data = value.data;
      const valid = isPlainObject(data)
        && typeof data.text === 'string'
        && (data.next_offset === null || isCount(data.next_offset))
        && isCount(data.revision);
      if (!valid) {
        writeGroupTexts(groupId, { loading: false, error: TRANSPORT_FAILURE });
        return;
      }
      writeGroupTexts(groupId, {
        loading: false,
        error: null,
        text: (replace ? '' : base.text) + data.text,
        next_offset: data.next_offset,
        revision: data.revision,
      });
    } finally {
      readingGroups[groupId] = false;
    }
  }

  function collapseGroup(groupId) {
    if (disposed) return;
    if (snapshot.expanded[groupId] !== true) return;
    setExpanded(groupId, false);
  }

  function loadMoreGroup(groupId) {
    if (disposed) return;
    const existing = snapshot.group_texts[groupId];
    if (existing === undefined || existing.next_offset === null || existing.next_offset === undefined) return;
    readGroupPage(groupId, existing.next_offset, false).catch(() => {});
  }

  async function exportReport() {
    if (disposed || exporting) return;
    if (snapshot.observation === null || snapshot.context === null) {
      update({ export_state: { phase: 'denied', report_ref: null, digest: null, reason_code: 'STALE_OBSERVATION' } });
      return;
    }
    if (snapshot.export_roots.length === 0) {
      update({ export_state: { phase: 'denied', report_ref: null, digest: null, reason_code: 'OUTPUT_REF_DENIED' } });
      return;
    }
    exporting = true;
    const requestEpoch = epoch;
    const controller = newController();
    const outputRef = snapshot.export_roots[0];
    update({ export_state: { phase: 'exporting', report_ref: null, digest: null, reason_code: null } });
    try {
      const payload = requestEnvelope(snapshot.context, {
        observation_id: snapshot.observation.observation_id,
        output_ref: outputRef,
        expected_revision: snapshot.observation.revision,
      });
      const response = await callEndpoint('report.export', payload, controller);
      if (requestEpoch !== epoch || disposed) return;
      if (!response.ok) {
        if (response.code === ABORTED || response.code === STALE_RESPONSE) {
          update({ export_state: { phase: 'idle', report_ref: null, digest: null, reason_code: null } });
          return;
        }
        update({
          export_state: {
            phase: 'error',
            report_ref: null,
            digest: null,
            reason_code: TRANSPORT_FAILURE,
          },
        });
        return;
      }
      const value = response.value;
      if (value.status !== 'ok') {
        const denial = statusFromFailure(value);
        update({
          export_state: {
            phase: denial.status === 'denied' ? 'denied' : 'error',
            report_ref: null,
            digest: null,
            reason_code: denial.reason_code === undefined ? null : denial.reason_code,
          },
        });
        return;
      }
      const data = value.data;
      if (!isPlainObject(data) || (data.status !== 'saved' && data.status !== 'conflict')) {
        update({ export_state: { phase: 'error', report_ref: null, digest: null, reason_code: TRANSPORT_FAILURE } });
        return;
      }
      if (data.status === 'conflict') {
        update({
          export_state: {
            phase: 'conflict',
            report_ref: typeof data.report_ref === 'string' ? data.report_ref : null,
            digest: typeof data.digest === 'string' ? data.digest : null,
            reason_code: 'EXPORT_CONFLICT',
          },
        });
        return;
      }
      update({
        export_state: {
          phase: 'saved',
          report_ref: typeof data.report_ref === 'string' ? data.report_ref : null,
          digest: typeof data.digest === 'string' ? data.digest : null,
          reason_code: null,
        },
      });
    } finally {
      exporting = false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    bumpEpoch();
    stopPolling();
    detachVisibility();
    update({ disposed: true, panel_active: false, status: 'idle' });
    listeners.clear();
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  return {
    getSnapshot,
    subscribe,
    whenIdle,
    selectSession,
    setPanelActive,
    setStage,
    setPaused,
    refresh,
    toggleGroup,
    collapseGroup,
    loadMoreGroup,
    exportReport,
    dispose,
  };
}
