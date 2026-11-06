/**
 * 07 context-mng: Host-side context service.
 *
 * This module is transport-agnostic: index.js maps Connection RPC endpoints and
 * the BusinessResponse envelope onto these methods. Every method re-joins the
 * request to the trusted access registry; content is only read after access is
 * granted. All denials/invalid states are raised as ContractError with a
 * registered reason code, which the RPC boundary converts to a fixed
 * BusinessResponse — raw errors never reach the wire.
 */

import {
  ContractError,
  LIMITS,
  SCHEMA_VERSION,
  CAPABILITY,
  isSafeCount,
  validateObservation,
  validateReport,
} from './contracts.mjs';

const LOW_SURROGATE = /[\uDC00-\uDFFF]/;
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;

/**
 * @param {{
 *   access: ReturnType<import('./access.mjs').createAccessRegistry>,
 *   store: object,
 *   capture: object,
 *   reportWriter: {writeReport: Function},
 *   policy: {redactionPolicyRevision: string},
 *   clock?: () => Date,
 *   limits?: object,
 * }} deps
 */
export function createContextService({
  access,
  store,
  capture,
  reportWriter,
  policy,
  clock = () => new Date(),
  limits = LIMITS,
}) {
  let disposed = false;

  function ensureLive() {
    if (disposed) throw new ContractError('context service disposed', 'INTERNAL_FAILURE');
  }

  function requireOwner(caller) {
    if (!access.isOwner(caller)) throw new ContractError('owner principal required', 'OWNER_REQUIRED');
  }

  /** @returns {{contexts: Array<object>}} */
  function listContexts({ caller }) {
    ensureLive();
    requireOwner(caller);
    return { contexts: access.listContexts(caller) };
  }

  function cachedLatest(binding, stage) {
    const entry = store.getLatest(binding.session_ref, stage);
    if (entry === null || entry === undefined) return null;
    if (entry.observation.boundary.scope.generation !== binding.scope.generation) return null;
    return entry;
  }

  /**
   * Read the latest observation for one authorized context/stage, capturing
   * the live session surface only when no cached observation exists and the
   * stage allows live sampling (session_surface). Historical request stages are
   * never fabricated: with no request observation the caller gets an empty
   * (changed:false, current_revision:0) result.
   *
   * @returns {Promise<{changed: boolean, observation?: object, current_revision: number}>}
   */
  async function getObservation({ caller, contextRef, expectedScopeGeneration, stage, afterRevision }) {
    ensureLive();
    requireOwner(caller);
    const binding = access.checkContext({ caller, contextRef, expectedScopeGeneration });

    const snapshot = cachedLatest(binding, stage);
    if (snapshot !== null) {
      const isNewer = afterRevision === undefined || snapshot.revision > afterRevision;
      return isNewer
        ? { changed: true, observation: snapshot.observation, current_revision: snapshot.revision }
        : { changed: false, current_revision: snapshot.revision };
    }

    if (stage !== 'session_surface') {
      return { changed: false, current_revision: 0 };
    }

    const captured = await capture.captureSurface({ binding, stage });
    if (captured.status !== 'ok') {
      throw new ContractError(`capture ${captured.status}`, captured.reasonCode ?? 'SESSION_UNAVAILABLE');
    }
    const result = validateObservation(captured.observation);
    if (!result.ok) {
      throw new ContractError('captured observation failed schema validation', 'INTERNAL_FAILURE', result.errors.slice(0, 3));
    }
    return { changed: true, observation: captured.observation, current_revision: captured.observation.revision };
  }

  /**
   * Resolve one cached observation that belongs to the authorized binding.
   * Rejects observations of another context/session/generation.
   */
  function entryFor({ caller, contextRef, expectedScopeGeneration, observationId }) {
    const binding = access.checkContext({ caller, contextRef, expectedScopeGeneration });
    const entry = store.getByObservationId(observationId);
    if (entry === null || entry === undefined) {
      throw new ContractError('observation is unknown or evicted', 'STALE_OBSERVATION');
    }
    if (entry.session_ref !== binding.session_ref) {
      throw new ContractError('observation does not belong to the authorized session', 'STALE_OBSERVATION');
    }
    if (entry.observation.boundary.scope.generation !== binding.scope.generation) {
      throw new ContractError('observation belongs to a different scope generation', 'STALE_SCOPE');
    }
    return { binding, entry };
  }

  /**
   * Page one group's full redacted text. The body is re-read from the live
   * session and the boundary must still match the cached observation.
   *
   * @returns {Promise<{text: string, next_offset: number|null, revision: number}>}
   */
  async function getGroupText({ caller, contextRef, expectedScopeGeneration, observationId, groupId, offset, limit }) {
    ensureLive();
    requireOwner(caller);
    const { binding, entry } = entryFor({ caller, contextRef, expectedScopeGeneration, observationId });
    const known = entry.observation.groups.find((group) => group.group_id === groupId);
    if (known === undefined) throw new ContractError('group is not part of this observation', 'INVALID_REQUEST');

    const re = await capture.readGroupTexts({ binding, observation: entry.observation });
    if (re.status === 'stale') throw new ContractError('session surface changed since the observation', 'STALE_OBSERVATION');
    if (re.status !== 'ok') throw new ContractError('session unavailable', re.reasonCode ?? 'SESSION_UNAVAILABLE');

    const group = re.groups.get(groupId);
    if (group === undefined) throw new ContractError('group changed since the observation', 'STALE_OBSERVATION');

    const text = group.text;
    const pageSize = limit === undefined ? limits.groupPageDefault : Math.min(limit, limits.groupPageMax);
    const window = pageText(text, offset, pageSize);
    return { text: window.text, next_offset: window.next_offset, revision: entry.revision };
  }

  /**
   * Export the already-redacted observation into a registered local root.
   *
   * @returns {Promise<{status: 'saved', report_ref: string, digest: string}>}
   */
  async function exportReport({ caller, contextRef, expectedScopeGeneration, observationId, outputRef, expectedRevision }) {
    ensureLive();
    requireOwner(caller);
    const { binding, rootPath } = access.checkExport({ caller, contextRef, expectedScopeGeneration, outputRef });
    const entry = store.getByObservationId(observationId);
    if (entry === null || entry === undefined) throw new ContractError('observation is unknown or evicted', 'STALE_OBSERVATION');
    if (entry.session_ref !== binding.session_ref) throw new ContractError('observation does not belong to the authorized session', 'STALE_OBSERVATION');
    if (entry.revision !== expectedRevision) throw new ContractError('observation revision changed', 'STALE_OBSERVATION');
    if (entry.observation.boundary.scope.generation !== binding.scope.generation) throw new ContractError('scope generation changed', 'STALE_SCOPE');

    const observationCheck = validateObservation(entry.observation);
    if (!observationCheck.ok) throw new ContractError('cached observation is invalid', 'INTERNAL_FAILURE', observationCheck.errors.slice(0, 3));

    const reportId = `ctx-report-${hashName(observationId)}-r${entry.revision}`;
    const report = {
      schema_version: SCHEMA_VERSION,
      capability: CAPABILITY,
      report_id: reportId,
      exported_at: clock().toISOString(),
      observation: entry.observation,
      redaction_policy_revision: policy.redactionPolicyRevision,
    };
    const reportCheck = validateReport(report);
    if (!reportCheck.ok) throw new ContractError('report failed schema validation', 'INTERNAL_FAILURE', reportCheck.errors.slice(0, 3));

    const written = await reportWriter.writeReport({
      rootPath,
      report,
      fileName: `${reportId}.json`,
    });
    if (written.status === 'conflict') {
      return { status: 'conflict' };
    }
    if (written.status !== 'saved') throw new ContractError('report write failed', 'INTERNAL_FAILURE');
    return { status: 'saved', report_ref: written.report_ref, digest: written.digest };
  }

  function describe() {
    ensureLive();
    return {
      registry: access.describe(),
      cache: store.stats(),
      policy,
      limits: {
        maxGroups: limits.maxGroups,
        maxPreviewChars: limits.maxPreviewChars,
        groupPageDefault: limits.groupPageDefault,
        groupPageMax: limits.groupPageMax,
        maxObservationsPerSession: limits.maxObservationsPerSession,
        maxSessionSnapshotBytes: limits.maxSessionSnapshotBytes,
        totalCacheBytes: limits.totalCacheBytes,
      },
    };
  }

  function dispose() {
    disposed = true;
  }

  return { listContexts, getObservation, getGroupText, exportReport, describe, dispose };
}

/**
 * Slice by UTF-16 code units without splitting a surrogate pair. The returned
 * next_offset always points to a safe boundary or null at end of text. When a
 * one-unit page would split a pair, the pair is included so pagination always
 * makes progress.
 */
export function pageText(text, offset, limit) {
  const length = text.length;
  let start = Math.min(Math.max(0, offset), length);
  if (start > 0 && start < length && LOW_SURROGATE.test(text.charAt(start))) start -= 1;
  let end = Math.min(start + Math.max(1, limit), length);
  if (end > start && end < length && HIGH_SURROGATE.test(text.charAt(end - 1)) && LOW_SURROGATE.test(text.charAt(end))) {
    end -= 1;
  }
  if (end <= start) end = Math.min(start + 2, length);
  return {
    text: text.slice(start, end),
    next_offset: end < length ? end : null,
  };
}

function hashName(id) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
