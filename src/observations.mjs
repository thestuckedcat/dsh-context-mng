/**
 * 07 context-mng: bounded, in-memory observation store.
 *
 * Responsibilities (docs/software-design.md §4, §6):
 *  - keep the last few ContextObservationV1 snapshots per session, with a
 *    per-session monotonic revision and content dedupe;
 *  - enforce the exact engineering bounds: <= maxObservationsPerSession
 *    snapshots, <= maxSessionSnapshotBytes per session, <= totalCacheBytes for
 *    the whole plugin with least-recently-used whole-session eviction;
 *  - never persist message body text: callers may only cache the projection
 *    snapshot (redacted previews, counts, ids), and oversized snapshots are
 *    truncated with honest `truncated` / `omitted_bytes` / estimate.complete
 *    flags instead of pretending completeness;
 *  - notify subscribers about new revisions and invalidation;
 *  - clear everything on dispose (the plugin keeps no durable observation).
 *
 * The store is transport- and Host-agnostic: it never reads a session, never
 * awaits and never touches the network.
 */

import {
  ContractError,
  LIMITS,
  canonicalJson,
  isNonEmptyString,
  isPlainObject,
  sha256Hex,
  validateObservation,
} from './contracts.mjs';

const STAGES = new Set(['session_surface', 'agent_pre_step', 'llm_waterfall']);

/** The digest of a snapshot that the store had to trim itself. */
function snapshotDigest(observation) {
  return sha256Hex(canonicalJson({
    groups: observation.groups.map((group) => ({
      group_id: group.group_id,
      category: group.category,
      source_ref: group.source_ref,
      source_kind: group.source_kind,
      message_refs: group.message_refs,
      characters: group.characters,
      bytes: group.bytes,
      estimated_tokens: group.estimated_tokens,
      certainty: group.certainty,
      preview: group.preview,
      truncated: group.truncated,
      redaction_count: group.redaction_count,
    })),
    estimate: observation.estimate,
    truncated: observation.truncated,
    omitted_bytes: observation.omitted_bytes,
    redaction_count: observation.groups.reduce((total, group) => total + group.redaction_count, 0),
  }));
}

/** JSON round-trip detach: the store owns its snapshots and never aliases callers. */
function detach(value) {
  return JSON.parse(JSON.stringify(value));
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Trim one observation so its serialized form fits `maxBytes`.
 *
 * Strategy (honest, never silently lossy):
 *  1. shorten group previews (halving the limit) and mark each affected group
 *     `truncated: true`;
 *  2. drop whole groups from the tail, count their bytes in `omitted_bytes`,
 *     set the top-level `truncated` flag and invalidate the estimate
 *     (`complete:false`, `tokens:null`) because the retained content is now a
 *     strict subset;
 *  3. recompute `observed_digest` over the trimmed snapshot so the digest
 *     always describes what is stored.
 *
 * The capture layer normally pre-fits observations with the projector's own
 * `computeObservedDigest`, so this defensive path only runs for snapshots that
 * bypassed that budget check.
 *
 * @param {object} observation
 * @param {number} maxBytes
 * @param {(trimmed: object) => string} [digestFn]
 * @returns {{observation: object, bytes: number, trimmed: boolean}}
 */
export function fitObservationSnapshot(observation, maxBytes, digestFn = snapshotDigest) {
  let bytes = serializedBytes(observation);
  if (bytes <= maxBytes) return { observation, bytes, trimmed: false };
  if (typeof digestFn !== 'function') digestFn = snapshotDigest;

  let groups = observation.groups.map((group) => ({ ...group }));
  let observationCandidate = { ...observation, groups };
  let previewLimit = LIMITS.maxPreviewChars;
  while (bytes > maxBytes && previewLimit > 0) {
    previewLimit = Math.floor(previewLimit / 2);
    groups = groups.map((group) => (group.preview.length > previewLimit
      ? { ...group, preview: group.preview.slice(0, previewLimit), truncated: true }
      : group));
    observationCandidate = { ...observationCandidate, groups, truncated: true };
    bytes = serializedBytes(observationCandidate);
  }

  let omittedBytes = observationCandidate.omitted_bytes ?? 0;
  if (bytes > maxBytes) {
    const base = { ...observationCandidate, groups: [] };
    let used = serializedBytes(base);
    let kept = 0;
    for (const group of groups) {
      const groupBytes = serializedBytes(group) + 1; // comma separator
      if (used + groupBytes > maxBytes) break;
      used += groupBytes;
      kept += 1;
    }
    const dropped = groups.slice(kept);
    if (dropped.length > 0) {
      for (const group of dropped) omittedBytes += serializedBytes(group) + 1;
      groups = groups.slice(0, kept);
      observationCandidate = {
        ...observationCandidate,
        groups,
        truncated: true,
        omitted_bytes: omittedBytes,
        estimate: { ...observation.estimate, complete: false, tokens: null },
      };
      bytes = serializedBytes(observationCandidate);
    }
  } else {
    // Preview-only trim: counts still describe the full content, so the
    // estimate stays complete but the snapshot itself is flagged truncated.
    observationCandidate = { ...observationCandidate, truncated: true };
    bytes = serializedBytes(observationCandidate);
  }

  observationCandidate.observed_digest = digestFn(observationCandidate);
  bytes = serializedBytes(observationCandidate);
  return { observation: observationCandidate, bytes, trimmed: true };
}

/**
 * @param {{limits?: object, clock?: () => Date}} [options]
 */
export function createObservationStore({ limits = LIMITS, clock = () => new Date() } = {}) {
  /** Merged engineering bounds; callers normally pass contracts.LIMITS. */
  const budget = {
    maxObservationsPerSession: LIMITS.maxObservationsPerSession,
    maxSessionSnapshotBytes: LIMITS.maxSessionSnapshotBytes,
    totalCacheBytes: LIMITS.totalCacheBytes,
    ...(isPlainObject(limits) ? limits : {}),
  };
  for (const key of ['maxObservationsPerSession', 'maxSessionSnapshotBytes', 'totalCacheBytes']) {
    const value = budget[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new ContractError(`observation store limit ${key} must be a non-negative safe integer`, 'INVALID_REQUEST');
    }
  }
  if (budget.totalCacheBytes < budget.maxSessionSnapshotBytes) {
    // A single session may not be allowed to consume the whole plugin budget.
    budget.maxSessionSnapshotBytes = Math.min(budget.maxSessionSnapshotBytes, budget.totalCacheBytes);
  }
  if (typeof clock !== 'function') throw new ContractError('observation store clock must be a function', 'INVALID_REQUEST');

  let disposed = false;
  /** @type {Map<string, {entries: object[], bytes: number, lastUse: number}>} */
  const sessions = new Map();
  /** Revisions stay monotonic across invalidations (a cleared session does not reset the clock). */
  const revisionCounters = new Map();
  /** observation_id -> {session_ref, revision} so group.read/export can resolve a snapshot. */
  const observationIndex = new Map();
  /** session_ref -> Set<listener> */
  const listeners = new Map();
  let useCounter = 0;
  const counters = { deduped: 0, trimmed: 0, evicted_sessions: 0, evicted_snapshots: 0 };

  function ensureLive() {
    if (disposed) throw new ContractError('observation store is disposed', 'INTERNAL_FAILURE');
  }

  function totalBytes() {
    let total = 0;
    for (const state of sessions.values()) total += state.bytes;
    return total;
  }

  function sessionState(sessionRef) {
    let state = sessions.get(sessionRef);
    if (state === undefined) {
      state = { entries: [], bytes: 0, lastUse: 0 };
      sessions.set(sessionRef, state);
    }
    return state;
  }

  function indexEntry(entry) {
    observationIndex.set(entry.observation.observation_id, { session_ref: entry.session_ref, revision: entry.revision });
  }

  function unindexEntry(entry) {
    observationIndex.delete(entry.observation.observation_id);
  }

  function dropEntry(sessionRef, state, entry) {
    const index = state.entries.indexOf(entry);
    if (index >= 0) state.entries.splice(index, 1);
    state.bytes -= entry.bytes;
    unindexEntry(entry);
    counters.evicted_snapshots += 1;
  }

  function enforceSessionBound(sessionRef, state) {
    while (state.entries.length > budget.maxObservationsPerSession) {
      dropEntry(sessionRef, state, state.entries[0]);
    }
    while (state.bytes > budget.maxSessionSnapshotBytes && state.entries.length > 1) {
      dropEntry(sessionRef, state, state.entries[0]);
    }
    if (state.entries.length === 0) {
      state.bytes = 0;
      sessions.delete(sessionRef);
    }
  }

  /** Whole-session LRU eviction keeps the plugin-wide cache within its budget. */
  function enforceTotalBound(currentSessionRef) {
    while (totalBytes() > budget.totalCacheBytes) {
      const populated = [...sessions.entries()].filter(([, state]) => state.entries.length > 0);
      if (populated.length === 0) return;
      populated.sort((left, right) => left[1].lastUse - right[1].lastUse);
      const [oldestRef, oldestState] = populated[0];
      if (populated.length === 1) {
        // The only remaining session is still over budget (small configured
        // totals): shed its oldest snapshot, never the newest one.
        if (oldestState.entries.length <= 1) return;
        dropEntry(oldestRef, oldestState, oldestState.entries[0]);
        continue;
      }
      // Prefer evicting a session other than the one being written.
      const victim = oldestRef === currentSessionRef ? populated[1] : populated[0];
      const [victimRef, victimState] = victim;
      for (const entry of victimState.entries) unindexEntry(entry);
      victimState.entries = [];
      victimState.bytes = 0;
      sessions.delete(victimRef);
      counters.evicted_sessions += 1;
    }
  }

  function notify(sessionRef, event) {
    const set = listeners.get(sessionRef);
    if (set === undefined || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // Listener failures are diagnostic-only: they must never break put().
      }
    }
  }

  /**
   * Cache one observation snapshot.
   *
   * @param {{session_ref: string, stage: 'session_surface'|'agent_pre_step'|'llm_waterfall',
   *   request_ref?: string|null, boundary: object, observation: object}} input
   * @returns {{revision: number, observation: object, deduped: boolean}}
   */
  function put(input) {
    ensureLive();
    if (!isPlainObject(input)) throw new ContractError('observation put input must be an object', 'INVALID_REQUEST');
    const { session_ref: sessionRef, stage, request_ref: requestRef = null, boundary, observation } = input;
    if (!isNonEmptyString(sessionRef)) throw new ContractError('session_ref must be 1..128 chars', 'INVALID_REQUEST');
    if (!STAGES.has(stage)) throw new ContractError('stage must be one of the capture stages', 'INVALID_REQUEST');
    if (requestRef !== null && !isNonEmptyString(requestRef)) {
      throw new ContractError('request_ref must be null or 1..128 chars', 'INVALID_REQUEST');
    }
    if (!isPlainObject(boundary) || boundary.session_ref !== sessionRef) {
      throw new ContractError('boundary must be an object for this session', 'INVALID_REQUEST');
    }
    if (!isPlainObject(observation)) throw new ContractError('observation must be an object', 'INVALID_REQUEST');
    const validation = validateObservation(observation);
    if (!validation.ok) {
      throw new ContractError('observation failed contract validation', 'INVALID_REQUEST', validation.errors.slice(0, 5));
    }
    if (observation.boundary.session_ref !== sessionRef || canonicalJson(observation.boundary) !== canonicalJson(boundary)) {
      throw new ContractError('observation.boundary does not match the put boundary', 'INVALID_REQUEST');
    }

    const state = sessionState(sessionRef);
    state.lastUse = ++useCounter;

    const boundaryDigest = sha256Hex(canonicalJson(boundary));
    const dedupeKey = [
      stage,
      requestRef === null ? `bnd:${boundaryDigest}` : `req:${requestRef}`,
      observation.observed_digest === null ? 'digest:null' : `digest:${observation.observed_digest}`,
    ].join('\u0000');

    // Host re-delivery of the same event must not duplicate the snapshot.
    for (let index = state.entries.length - 1; index >= 0; index -= 1) {
      const entry = state.entries[index];
      if (entry.stage !== stage) continue;
      if (entry.dedupeKey === dedupeKey) {
        counters.deduped += 1;
        return { revision: entry.revision, observation: entry.observation, deduped: true };
      }
      break;
    }

    const revision = (revisionCounters.get(sessionRef) ?? 0) + 1;
    revisionCounters.set(sessionRef, revision);
    const detached = detach({ ...observation, revision });
    const fitted = fitObservationSnapshot(detached, budget.maxSessionSnapshotBytes);
    if (fitted.trimmed) counters.trimmed += 1;
    const entry = {
      session_ref: sessionRef,
      stage,
      revision,
      boundary: fitted.observation.boundary,
      observation: Object.freeze(fitted.observation),
      dedupeKey,
      bytes: fitted.bytes,
    };
    state.entries.push(entry);
    state.bytes += fitted.bytes;
    indexEntry(entry);
    enforceSessionBound(sessionRef, state);
    enforceTotalBound(sessionRef);

    const current = sessions.get(sessionRef);
    if (current !== undefined && current.entries.includes(entry)) {
      notify(sessionRef, { session_ref: sessionRef, stage, revision, observation: entry.observation, invalidated: false });
    }
    return { revision, observation: entry.observation, deduped: false };
  }

  function getLatest(sessionRef, stage) {
    if (disposed) return null;
    if (!isNonEmptyString(sessionRef) || !STAGES.has(stage)) return null;
    const state = sessions.get(sessionRef);
    if (state === undefined) return null;
    state.lastUse = ++useCounter;
    for (let index = state.entries.length - 1; index >= 0; index -= 1) {
      const entry = state.entries[index];
      if (entry.stage === stage) return entry;
    }
    return null;
  }

  function getByObservationId(observationId) {
    if (disposed) return null;
    if (!isNonEmptyString(observationId)) return null;
    const reference = observationIndex.get(observationId);
    if (reference === undefined) return null;
    const state = sessions.get(reference.session_ref);
    if (state === undefined) return null;
    for (const entry of state.entries) {
      if (entry.observation.observation_id === observationId) {
        state.lastUse = ++useCounter;
        return entry;
      }
    }
    observationIndex.delete(observationId);
    return null;
  }

  function entriesForSession(sessionRef) {
    if (disposed) return [];
    if (!isNonEmptyString(sessionRef)) return [];
    const state = sessions.get(sessionRef);
    if (state === undefined) return [];
    state.lastUse = ++useCounter;
    return state.entries.slice();
  }

  function subscribe(sessionRef, listener) {
    if (disposed) return () => {};
    if (!isNonEmptyString(sessionRef)) throw new ContractError('session_ref must be 1..128 chars', 'INVALID_REQUEST');
    if (typeof listener !== 'function') throw new ContractError('listener must be a function', 'INVALID_REQUEST');
    let set = listeners.get(sessionRef);
    if (set === undefined) {
      set = new Set();
      listeners.set(sessionRef, set);
    }
    set.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = listeners.get(sessionRef);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) listeners.delete(sessionRef);
    };
  }

  /** Session removed/rewound: drop every cached body immediately. */
  function invalidateSession(sessionRef) {
    if (disposed) return;
    if (!isNonEmptyString(sessionRef)) return;
    const state = sessions.get(sessionRef);
    if (state !== undefined) {
      for (const entry of state.entries) unindexEntry(entry);
      state.entries = [];
      state.bytes = 0;
      sessions.delete(sessionRef);
    }
    notify(sessionRef, { session_ref: sessionRef, stage: null, revision: null, observation: null, invalidated: true });
  }

  function stats() {
    if (disposed) {
      return {
        sessions: 0,
        entries: 0,
        bytes: 0,
        max_total_bytes: budget.totalCacheBytes,
        max_session_bytes: budget.maxSessionSnapshotBytes,
        max_observations_per_session: budget.maxObservationsPerSession,
        deduped: counters.deduped,
        trimmed: counters.trimmed,
        evicted_sessions: counters.evicted_sessions,
        evicted_snapshots: counters.evicted_snapshots,
      };
    }
    let entries = 0;
    for (const state of sessions.values()) entries += state.entries.length;
    return {
      sessions: sessions.size,
      entries,
      bytes: totalBytes(),
      max_total_bytes: budget.totalCacheBytes,
      max_session_bytes: budget.maxSessionSnapshotBytes,
      max_observations_per_session: budget.maxObservationsPerSession,
      deduped: counters.deduped,
      trimmed: counters.trimmed,
      evicted_sessions: counters.evicted_sessions,
      evicted_snapshots: counters.evicted_snapshots,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const state of sessions.values()) {
      for (const entry of state.entries) unindexEntry(entry);
      state.entries = [];
      state.bytes = 0;
    }
    sessions.clear();
    revisionCounters.clear();
    observationIndex.clear();
    listeners.clear();
  }

  return {
    put,
    getLatest,
    getByObservationId,
    entriesForSession,
    subscribe,
    invalidateSession,
    stats,
    dispose,
  };
}
