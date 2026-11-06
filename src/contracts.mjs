/**
 * 07 context-mng: strict internal contracts (v1).
 *
 * This module is the single source of truth for:
 *  - wire/request/response shapes used by the Host <-> Client RPC;
 *  - observation/report/access-registry shapes;
 *  - engineering limits and registered reason codes;
 *  - small deterministic helpers shared by the pure core.
 *
 * Conventions (see docs/software-design.md §4):
 *  - additional fields are rejected; optional absence is never "null" unless a
 *    field is explicitly nullable;
 *  - string ids are 1..128 characters; digests are 64 lowercase hex;
 *  - counters are non-negative safe integers; times are UTC ISO-8601 strings.
 */

import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const CAPABILITY = '07';
export const REDACTION_POLICY_REVISION = 'REDACT-1';
export const ESTIMATE_METHOD = 'utf8_bytes_estimate_v1';

/** Engineering bounds (adjustable defaults, not user-confirmed performance targets). */
export const LIMITS = Object.freeze({
  maxGroups: 5000,
  maxPreviewChars: 512,
  maxTextCharsPerGroup: 4 * 1024 * 1024,
  maxObservationsPerSession: 8,
  maxSessionSnapshotBytes: 2 * 1024 * 1024,
  totalCacheBytes: 32 * 1024 * 1024,
  groupPageDefault: 8192,
  groupPageMax: 32768,
  maxRequestJsonBytes: 64 * 1024,
  maxResponseJsonBytes: 2 * 1024 * 1024,
  maxIdChars: 128,
  coalesceWindowMsMin: 10,
  coalesceWindowMsMax: 1000,
  maxRefreshHzMin: 1,
  maxRefreshHzMax: 20,
});

export const CATEGORIES = Object.freeze([
  'system',
  'developer',
  'user',
  'assistant',
  'tools',
  'tool_result',
  'memory',
  'unknown',
]);

export const CERTAINTIES = Object.freeze(['identified', 'heuristic', 'unknown']);

export const CAPTURE_STAGES = Object.freeze([
  'session_surface',
  'agent_pre_step',
  'llm_waterfall',
]);

export const FIDELITIES = Object.freeze([
  'history_projection',
  'request_observed',
  'unavailable',
]);

export const ESTIMATE_METHODS = Object.freeze(['utf8_bytes_estimate_v1', 'locked_tokenizer']);

/** Registered reason codes. Unknown codes must not be sent on the wire. */
export const REASON_CODES = Object.freeze([
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
]);

export const BUSINESS_STATUSES = Object.freeze([
  'ok',
  'denied',
  'stale',
  'unavailable',
  'invalid',
  'failed',
]);

export const ENDPOINTS = Object.freeze([
  'context.list',
  'observation.get',
  'group.read',
  'report.export',
]);

export class ContractError extends Error {
  constructor(message, reasonCode = 'INVALID_REQUEST', details = undefined) {
    super(message);
    this.name = 'ContractError';
    this.reasonCode = REASON_CODES.includes(reasonCode) ? reasonCode : 'INVALID_REQUEST';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// primitive validators
// ---------------------------------------------------------------------------

export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isNonEmptyString(value, max = LIMITS.maxIdChars) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

export function isSafeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isUtcIso(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function utf8ByteLength(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Deterministic JSON used for digests: sorted object keys, no whitespace. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

function unknownKeyErrors(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push({ path: `${path}.${key}`, code: 'UNKNOWN_FIELD', message: `unexpected field ${key}` });
    }
  }
}

/** Collect errors instead of throwing: `{ok:true, value}` / `{ok:false, errors}`. */
function check(errors) {
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// shared shapes
// ---------------------------------------------------------------------------

export function validateScopeRef(value, path = 'scope') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'scope must be an object' }]);
  unknownKeyErrors(value, ['scope_id', 'generation', 'identity_digest'], path, errors);
  if (!isNonEmptyString(value.scope_id)) errors.push({ path: `${path}.scope_id`, code: 'TYPE', message: 'scope_id must be 1..128 chars' });
  if (!isSafeCount(value.generation)) errors.push({ path: `${path}.generation`, code: 'TYPE', message: 'generation must be a non-negative safe integer' });
  if (!isHex64(value.identity_digest)) errors.push({ path: `${path}.identity_digest`, code: 'TYPE', message: 'identity_digest must be 64 lowercase hex' });
  return check(errors);
}

export function validateBoundary(value, path = 'boundary') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'boundary must be an object' }]);
  unknownKeyErrors(value, ['session_ref', 'scope', 'last_event_seq', 'surface_generation', 'route_revision', 'observation_epoch'], path, errors);
  if (!isNonEmptyString(value.session_ref)) errors.push({ path: `${path}.session_ref`, code: 'TYPE', message: 'session_ref must be 1..128 chars' });
  const scope = validateScopeRef(value.scope, `${path}.scope`);
  if (!scope.ok) errors.push(...scope.errors);
  if (!isSafeCount(value.last_event_seq)) errors.push({ path: `${path}.last_event_seq`, code: 'TYPE', message: 'last_event_seq must be a non-negative safe integer (accepted event count)' });
  if (!isSafeCount(value.surface_generation)) errors.push({ path: `${path}.surface_generation`, code: 'TYPE', message: 'surface_generation must be a non-negative safe integer' });
  if (!isNonEmptyString(value.route_revision)) errors.push({ path: `${path}.route_revision`, code: 'TYPE', message: 'route_revision must be 1..128 chars' });
  if (!isSafeCount(value.observation_epoch)) errors.push({ path: `${path}.observation_epoch`, code: 'TYPE', message: 'observation_epoch must be a non-negative safe integer' });
  return check(errors);
}

export function validateEstimate(value, path = 'estimate') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'estimate must be an object' }]);
  unknownKeyErrors(value, ['method', 'tokenizer_ref', 'tokens', 'complete', 'unpriced_modalities'], path, errors);
  if (!ESTIMATE_METHODS.includes(value.method)) errors.push({ path: `${path}.method`, code: 'ENUM', message: `method must be one of ${ESTIMATE_METHODS.join(',')}` });
  if (value.tokenizer_ref !== null && !isNonEmptyString(value.tokenizer_ref)) errors.push({ path: `${path}.tokenizer_ref`, code: 'TYPE', message: 'tokenizer_ref must be null or 1..128 chars' });
  if (value.tokens !== null && !isSafeCount(value.tokens)) errors.push({ path: `${path}.tokens`, code: 'TYPE', message: 'tokens must be null or a non-negative safe integer' });
  if (typeof value.complete !== 'boolean') errors.push({ path: `${path}.complete`, code: 'TYPE', message: 'complete must be a boolean' });
  if (!Array.isArray(value.unpriced_modalities) || value.unpriced_modalities.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 64)) {
    errors.push({ path: `${path}.unpriced_modalities`, code: 'TYPE', message: 'unpriced_modalities must be an array of short strings' });
  }
  return check(errors);
}

export function validateReportedUsage(value, path = 'reported_usage') {
  const errors = [];
  if (value === null) return { ok: true };
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'reported_usage must be null or an object' }]);
  unknownKeyErrors(value, ['request_ref', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'source', 'is_final'], path, errors);
  if (!isNonEmptyString(value.request_ref)) errors.push({ path: `${path}.request_ref`, code: 'TYPE', message: 'request_ref must be 1..128 chars' });
  for (const field of ['input_tokens', 'output_tokens', 'cached_input_tokens']) {
    if (value[field] !== null && !isSafeCount(value[field])) errors.push({ path: `${path}.${field}`, code: 'TYPE', message: `${field} must be null or a non-negative safe integer` });
  }
  if (value.source !== 'provider_usage_chunk') errors.push({ path: `${path}.source`, code: 'ENUM', message: 'source must be provider_usage_chunk' });
  if (typeof value.is_final !== 'boolean') errors.push({ path: `${path}.is_final`, code: 'TYPE', message: 'is_final must be a boolean' });
  return check(errors);
}

export function validateLimits(value, path = 'limits') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'limits must be an object' }]);
  unknownKeyErrors(value, ['context_window', 'max_output_tokens'], path, errors);
  for (const field of ['context_window', 'max_output_tokens']) {
    if (value[field] !== null && !isSafeCount(value[field])) errors.push({ path: `${path}.${field}`, code: 'TYPE', message: `${field} must be null or a non-negative safe integer` });
  }
  return check(errors);
}

export function validateContextGroup(value, path = 'group') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'group must be an object' }]);
  unknownKeyErrors(value, [
    'group_id', 'category', 'source_ref', 'source_kind', 'message_refs', 'characters', 'bytes',
    'estimated_tokens', 'certainty', 'preview', 'truncated', 'redaction_count',
  ], path, errors);
  if (!isNonEmptyString(value.group_id)) errors.push({ path: `${path}.group_id`, code: 'TYPE', message: 'group_id must be 1..128 chars' });
  if (!CATEGORIES.includes(value.category)) errors.push({ path: `${path}.category`, code: 'ENUM', message: `category must be one of ${CATEGORIES.join(',')}` });
  if (value.source_ref !== null && !isNonEmptyString(value.source_ref)) errors.push({ path: `${path}.source_ref`, code: 'TYPE', message: 'source_ref must be null or 1..128 chars' });
  if (value.source_kind !== null && !isNonEmptyString(value.source_kind)) errors.push({ path: `${path}.source_kind`, code: 'TYPE', message: 'source_kind must be null or 1..128 chars' });
  if (!Array.isArray(value.message_refs) || value.message_refs.length > 10000 || value.message_refs.some((item) => !isNonEmptyString(item))) {
    errors.push({ path: `${path}.message_refs`, code: 'TYPE', message: 'message_refs must be an array of ids (<=10000)' });
  }
  for (const field of ['characters', 'bytes', 'redaction_count']) {
    if (!isSafeCount(value[field])) errors.push({ path: `${path}.${field}`, code: 'TYPE', message: `${field} must be a non-negative safe integer` });
  }
  if (value.estimated_tokens !== null && !isSafeCount(value.estimated_tokens)) errors.push({ path: `${path}.estimated_tokens`, code: 'TYPE', message: 'estimated_tokens must be null or a non-negative safe integer' });
  if (!CERTAINTIES.includes(value.certainty)) errors.push({ path: `${path}.certainty`, code: 'ENUM', message: `certainty must be one of ${CERTAINTIES.join(',')}` });
  if (typeof value.preview !== 'string' || value.preview.length > LIMITS.maxPreviewChars) errors.push({ path: `${path}.preview`, code: 'TYPE', message: `preview must be a string <= ${LIMITS.maxPreviewChars} chars` });
  if (typeof value.truncated !== 'boolean') errors.push({ path: `${path}.truncated`, code: 'TYPE', message: 'truncated must be a boolean' });
  return check(errors);
}

const OBSERVATION_KEYS = [
  'schema_version', 'observation_id', 'revision', 'boundary', 'captured_at', 'capture_stage',
  'fidelity', 'request_ref', 'provider_ref', 'model_ref', 'observed_digest', 'wire_verified',
  'groups', 'estimate', 'reported_usage', 'limits', 'truncated', 'omitted_bytes', 'unavailable_reason',
];

export function validateObservation(value, path = 'observation') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'observation must be an object' }]);
  unknownKeyErrors(value, OBSERVATION_KEYS, path, errors);
  if (value.schema_version !== SCHEMA_VERSION) errors.push({ path: `${path}.schema_version`, code: 'CONST', message: 'schema_version must be 1' });
  if (!isNonEmptyString(value.observation_id)) errors.push({ path: `${path}.observation_id`, code: 'TYPE', message: 'observation_id must be 1..128 chars' });
  if (!isSafeCount(value.revision)) errors.push({ path: `${path}.revision`, code: 'TYPE', message: 'revision must be a non-negative safe integer' });
  const boundary = validateBoundary(value.boundary, `${path}.boundary`);
  if (!boundary.ok) errors.push(...boundary.errors);
  if (!isUtcIso(value.captured_at)) errors.push({ path: `${path}.captured_at`, code: 'TYPE', message: 'captured_at must be UTC ISO-8601' });
  if (!CAPTURE_STAGES.includes(value.capture_stage)) errors.push({ path: `${path}.capture_stage`, code: 'ENUM', message: `capture_stage must be one of ${CAPTURE_STAGES.join(',')}` });
  if (!FIDELITIES.includes(value.fidelity)) errors.push({ path: `${path}.fidelity`, code: 'ENUM', message: `fidelity must be one of ${FIDELITIES.join(',')}` });
  for (const field of ['request_ref', 'provider_ref', 'model_ref']) {
    if (value[field] !== null && !isNonEmptyString(value[field])) errors.push({ path: `${path}.${field}`, code: 'TYPE', message: `${field} must be null or 1..128 chars` });
  }
  if (value.observed_digest !== null && !isHex64(value.observed_digest)) errors.push({ path: `${path}.observed_digest`, code: 'TYPE', message: 'observed_digest must be null or 64 lowercase hex' });
  if (value.wire_verified !== false) errors.push({ path: `${path}.wire_verified`, code: 'CONST', message: 'wire_verified must be false in v1' });
  if (!Array.isArray(value.groups) || value.groups.length > LIMITS.maxGroups) {
    errors.push({ path: `${path}.groups`, code: 'TYPE', message: `groups must be an array (<=${LIMITS.maxGroups})` });
  } else {
    value.groups.forEach((group, index) => {
      const result = validateContextGroup(group, `${path}.groups[${index}]`);
      if (!result.ok) errors.push(...result.errors);
    });
  }
  const estimate = validateEstimate(value.estimate, `${path}.estimate`);
  if (!estimate.ok) errors.push(...estimate.errors);
  const usage = validateReportedUsage(value.reported_usage, `${path}.reported_usage`);
  if (!usage.ok) errors.push(...usage.errors);
  const limits = validateLimits(value.limits, `${path}.limits`);
  if (!limits.ok) errors.push(...limits.errors);
  if (typeof value.truncated !== 'boolean') errors.push({ path: `${path}.truncated`, code: 'TYPE', message: 'truncated must be a boolean' });
  if (!isSafeCount(value.omitted_bytes)) errors.push({ path: `${path}.omitted_bytes`, code: 'TYPE', message: 'omitted_bytes must be a non-negative safe integer' });
  if (value.unavailable_reason !== null && !isNonEmptyString(value.unavailable_reason)) errors.push({ path: `${path}.unavailable_reason`, code: 'TYPE', message: 'unavailable_reason must be null or a short string' });
  return check(errors);
}

export function validateReport(value, path = 'report') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'report must be an object' }]);
  unknownKeyErrors(value, ['schema_version', 'capability', 'report_id', 'exported_at', 'observation', 'redaction_policy_revision'], path, errors);
  if (value.schema_version !== SCHEMA_VERSION) errors.push({ path: `${path}.schema_version`, code: 'CONST', message: 'schema_version must be 1' });
  if (value.capability !== CAPABILITY) errors.push({ path: `${path}.capability`, code: 'CONST', message: "capability must be '07'" });
  if (!isNonEmptyString(value.report_id)) errors.push({ path: `${path}.report_id`, code: 'TYPE', message: 'report_id must be 1..128 chars' });
  if (!isUtcIso(value.exported_at)) errors.push({ path: `${path}.exported_at`, code: 'TYPE', message: 'exported_at must be UTC ISO-8601' });
  if (!isNonEmptyString(value.redaction_policy_revision)) errors.push({ path: `${path}.redaction_policy_revision`, code: 'TYPE', message: 'redaction_policy_revision must be 1..128 chars' });
  const observation = validateObservation(value.observation, `${path}.observation`);
  if (!observation.ok) errors.push(...observation.errors);
  return check(errors);
}

// ---------------------------------------------------------------------------
// access registry
// ---------------------------------------------------------------------------

export function validateAccessRegistry(value, path = 'registry') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'registry must be an object' }]);
  unknownKeyErrors(value, ['schema_version', 'revision', 'bindings', 'export_roots'], path, errors);
  if (value.schema_version !== SCHEMA_VERSION) errors.push({ path: `${path}.schema_version`, code: 'CONST', message: 'schema_version must be 1' });
  if (!isSafeCount(value.revision)) errors.push({ path: `${path}.revision`, code: 'TYPE', message: 'revision must be a non-negative safe integer' });
  const exportRoots = new Map();
  if (!Array.isArray(value.export_roots)) {
    errors.push({ path: `${path}.export_roots`, code: 'TYPE', message: 'export_roots must be an array' });
  } else {
    value.export_roots.forEach((root, index) => {
      const rootPath = `${path}.export_roots[${index}]`;
      if (!isPlainObject(root)) { errors.push({ path: rootPath, code: 'TYPE', message: 'export root must be an object' }); return; }
      unknownKeyErrors(root, ['root_ref', 'path'], rootPath, errors);
      if (!isNonEmptyString(root.root_ref)) errors.push({ path: `${rootPath}.root_ref`, code: 'TYPE', message: 'root_ref must be 1..128 chars' });
      else if (exportRoots.has(root.root_ref)) errors.push({ path: `${rootPath}.root_ref`, code: 'DUPLICATE', message: `duplicate root_ref ${root.root_ref}` });
      else exportRoots.set(root.root_ref, root);
      if (typeof root.path !== 'string' || root.path.length === 0 || root.path.length > 1024) errors.push({ path: `${rootPath}.path`, code: 'TYPE', message: 'path must be a non-empty absolute path string' });
      else if (!/^[A-Za-z]:[\\/]|^\//.test(root.path)) errors.push({ path: `${rootPath}.path`, code: 'TYPE', message: 'path must be absolute' });
    });
  }
  if (!Array.isArray(value.bindings)) {
    errors.push({ path: `${path}.bindings`, code: 'TYPE', message: 'bindings must be an array' });
    return check(errors);
  }
  const contexts = new Set();
  const sessions = new Set();
  value.bindings.forEach((binding, index) => {
    const bindingPath = `${path}.bindings[${index}]`;
    if (!isPlainObject(binding)) { errors.push({ path: bindingPath, code: 'TYPE', message: 'binding must be an object' }); return; }
    unknownKeyErrors(binding, ['context_ref', 'scope', 'session_ref', 'read', 'export_root_refs', 'active'], bindingPath, errors);
    if (!isNonEmptyString(binding.context_ref)) errors.push({ path: `${bindingPath}.context_ref`, code: 'TYPE', message: 'context_ref must be 1..128 chars' });
    else if (contexts.has(binding.context_ref)) errors.push({ path: `${bindingPath}.context_ref`, code: 'DUPLICATE', message: `duplicate context_ref ${binding.context_ref}` });
    else contexts.add(binding.context_ref);
    const scope = validateScopeRef(binding.scope, `${bindingPath}.scope`);
    if (!scope.ok) errors.push(...scope.errors);
    if (!isNonEmptyString(binding.session_ref)) errors.push({ path: `${bindingPath}.session_ref`, code: 'TYPE', message: 'session_ref must be 1..128 chars' });
    else if (sessions.has(binding.session_ref)) errors.push({ path: `${bindingPath}.session_ref`, code: 'DUPLICATE', message: `duplicate session_ref ${binding.session_ref}` });
    else sessions.add(binding.session_ref);
    if (binding.read !== true) errors.push({ path: `${bindingPath}.read`, code: 'CONST', message: 'read must be true for a readable binding' });
    if (typeof binding.active !== 'boolean') errors.push({ path: `${bindingPath}.active`, code: 'TYPE', message: 'active must be a boolean' });
    if (!Array.isArray(binding.export_root_refs) || binding.export_root_refs.some((ref) => !isNonEmptyString(ref))) {
      errors.push({ path: `${bindingPath}.export_root_refs`, code: 'TYPE', message: 'export_root_refs must be an array of ids' });
    } else {
      for (const ref of binding.export_root_refs) {
        if (!exportRoots.has(ref)) errors.push({ path: `${bindingPath}.export_root_refs`, code: 'UNBOUND', message: `export root_ref ${ref} is not registered in export_roots` });
      }
    }
  });
  return check(errors);
}

// ---------------------------------------------------------------------------
// RPC request / response
// ---------------------------------------------------------------------------

const REQUEST_KEYS = ['schema_version', 'operation_id', 'context_ref', 'expected_scope_generation', 'view_epoch', 'input'];

export function validateRpcRequest(value, path = 'request') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'request must be an object' }]);
  unknownKeyErrors(value, REQUEST_KEYS, path, errors);
  if (value.schema_version !== SCHEMA_VERSION) errors.push({ path: `${path}.schema_version`, code: 'CONST', message: 'schema_version must be 1' });
  if (!isNonEmptyString(value.operation_id)) errors.push({ path: `${path}.operation_id`, code: 'TYPE', message: 'operation_id must be 1..128 chars' });
  if (!isNonEmptyString(value.context_ref)) errors.push({ path: `${path}.context_ref`, code: 'TYPE', message: 'context_ref must be 1..128 chars' });
  if (!isSafeCount(value.expected_scope_generation)) errors.push({ path: `${path}.expected_scope_generation`, code: 'TYPE', message: 'expected_scope_generation must be a non-negative safe integer' });
  if (!isSafeCount(value.view_epoch)) errors.push({ path: `${path}.view_epoch`, code: 'TYPE', message: 'view_epoch must be a non-negative safe integer' });
  if (!isPlainObject(value.input)) errors.push({ path: `${path}.input`, code: 'TYPE', message: 'input must be an object' });
  return check(errors);
}

export function validateStage(value) {
  return typeof value === 'string' && CAPTURE_STAGES.includes(value);
}

export function validateObservationInput(value, path = 'input') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'input must be an object' }]);
  unknownKeyErrors(value, ['stage', 'after_revision'], path, errors);
  if (!validateStage(value.stage)) errors.push({ path: `${path}.stage`, code: 'ENUM', message: `stage must be one of ${CAPTURE_STAGES.join(',')}` });
  if (value.after_revision !== undefined && !isSafeCount(value.after_revision)) errors.push({ path: `${path}.after_revision`, code: 'TYPE', message: 'after_revision must be absent or a non-negative safe integer' });
  return check(errors);
}

export function validateGroupReadInput(value, path = 'input') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'input must be an object' }]);
  unknownKeyErrors(value, ['observation_id', 'group_id', 'offset', 'limit'], path, errors);
  if (!isNonEmptyString(value.observation_id)) errors.push({ path: `${path}.observation_id`, code: 'TYPE', message: 'observation_id must be 1..128 chars' });
  if (!isNonEmptyString(value.group_id)) errors.push({ path: `${path}.group_id`, code: 'TYPE', message: 'group_id must be 1..128 chars' });
  if (!isSafeCount(value.offset)) errors.push({ path: `${path}.offset`, code: 'TYPE', message: 'offset must be a non-negative safe integer' });
  if (value.limit !== undefined) {
    if (!isSafeCount(value.limit) || value.limit < 1 || value.limit > LIMITS.groupPageMax) {
      errors.push({ path: `${path}.limit`, code: 'RANGE', message: `limit must be 1..${LIMITS.groupPageMax}` });
    }
  }
  return check(errors);
}

export function validateExportInput(value, path = 'input') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'input must be an object' }]);
  unknownKeyErrors(value, ['observation_id', 'output_ref', 'expected_revision'], path, errors);
  if (!isNonEmptyString(value.observation_id)) errors.push({ path: `${path}.observation_id`, code: 'TYPE', message: 'observation_id must be 1..128 chars' });
  if (!isNonEmptyString(value.output_ref)) errors.push({ path: `${path}.output_ref`, code: 'TYPE', message: 'output_ref must be 1..128 chars' });
  if (!isSafeCount(value.expected_revision)) errors.push({ path: `${path}.expected_revision`, code: 'TYPE', message: 'expected_revision must be a non-negative safe integer' });
  return check(errors);
}

export function validateContextListInput(value, path = 'input') {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path, code: 'TYPE', message: 'input must be an object' }]);
  unknownKeyErrors(value, [], path, errors);
  return check(errors);
}

export function validateBusinessResponse(value) {
  const errors = [];
  if (!isPlainObject(value)) return check([{ path: 'response', code: 'TYPE', message: 'response must be an object' }]);
  unknownKeyErrors(value, ['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status', 'data', 'reason_code'], 'response', errors);
  if (value.schema_version !== SCHEMA_VERSION) errors.push({ path: 'response.schema_version', code: 'CONST', message: 'schema_version must be 1' });
  if (!isNonEmptyString(value.operation_id)) errors.push({ path: 'response.operation_id', code: 'TYPE', message: 'operation_id must be 1..128 chars' });
  if (!isSafeCount(value.view_epoch)) errors.push({ path: 'response.view_epoch', code: 'TYPE', message: 'view_epoch must be a non-negative safe integer' });
  if (!isSafeCount(value.scope_generation)) errors.push({ path: 'response.scope_generation', code: 'TYPE', message: 'scope_generation must be a non-negative safe integer' });
  if (!BUSINESS_STATUSES.includes(value.status)) errors.push({ path: 'response.status', code: 'ENUM', message: `status must be one of ${BUSINESS_STATUSES.join(',')}` });
  if (value.status === 'ok') {
    if (value.data === undefined) errors.push({ path: 'response.data', code: 'MISSING', message: 'data is required when status is ok' });
    if (value.reason_code !== undefined) errors.push({ path: 'response.reason_code', code: 'UNKNOWN_FIELD', message: 'reason_code is not allowed when status is ok' });
  } else {
    if (!REASON_CODES.includes(value.reason_code)) errors.push({ path: 'response.reason_code', code: 'ENUM', message: 'reason_code must be a registered code' });
    if (value.data !== undefined) errors.push({ path: 'response.data', code: 'UNKNOWN_FIELD', message: 'data is not allowed on a failure response' });
  }
  return check(errors);
}

// ---------------------------------------------------------------------------
// plugin configuration (explicit registration; no implicit grants)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = Object.freeze({
  maintenance: { enabled: false },
  capture: Object.freeze({
    autoSampleSurface: true,
    requestObservation: true,
    agentPreStep: true,
    coalesceWindowMs: 100,
    maxRefreshHz: 10,
  }),
  access: Object.freeze({
    registry: Object.freeze({ schema_version: 1, revision: 1, bindings: [], export_roots: [] }),
  }),
});

export function normalizeConfig(raw) {
  const errors = [];
  if (raw !== undefined && !isPlainObject(raw)) {
    throw new ContractError('plugin config must be an object', 'INVALID_REQUEST');
  }
  const config = raw ?? {};
  unknownKeyErrors(config, ['maintenance', 'capture', 'access'], 'config', errors);
  const maintenance = { ...DEFAULT_CONFIG.maintenance, ...(isPlainObject(config.maintenance) ? config.maintenance : {}) };
  if (typeof maintenance.enabled !== 'boolean') errors.push({ path: 'config.maintenance.enabled', code: 'TYPE', message: 'enabled must be a boolean' });
  if (maintenance.enabled === true) errors.push({ path: 'config.maintenance.enabled', code: 'UNSUPPORTED', message: 'maintenance is a post-first-version increment and must stay disabled' });

  const captureRaw = isPlainObject(config.capture) ? config.capture : {};
  unknownKeyErrors(captureRaw, ['autoSampleSurface', 'requestObservation', 'agentPreStep', 'coalesceWindowMs', 'maxRefreshHz'], 'config.capture', errors);
  const capture = { ...DEFAULT_CONFIG.capture, ...captureRaw };
  for (const key of ['autoSampleSurface', 'requestObservation', 'agentPreStep']) {
    if (typeof capture[key] !== 'boolean') errors.push({ path: `config.capture.${key}`, code: 'TYPE', message: `${key} must be a boolean` });
  }
  if (!isSafeCount(capture.coalesceWindowMs) || capture.coalesceWindowMs < LIMITS.coalesceWindowMsMin || capture.coalesceWindowMs > LIMITS.coalesceWindowMsMax) {
    errors.push({ path: 'config.capture.coalesceWindowMs', code: 'RANGE', message: `coalesceWindowMs must be ${LIMITS.coalesceWindowMsMin}..${LIMITS.coalesceWindowMsMax}` });
  }
  if (!isSafeCount(capture.maxRefreshHz) || capture.maxRefreshHz < LIMITS.maxRefreshHzMin || capture.maxRefreshHz > LIMITS.maxRefreshHzMax) {
    errors.push({ path: 'config.capture.maxRefreshHz', code: 'RANGE', message: `maxRefreshHz must be ${LIMITS.maxRefreshHzMin}..${LIMITS.maxRefreshHzMax}` });
  }

  const accessRaw = isPlainObject(config.access) ? config.access : {};
  unknownKeyErrors(accessRaw, ['registry'], 'config.access', errors);
  const registry = accessRaw.registry ?? DEFAULT_CONFIG.access.registry;
  const registryResult = validateAccessRegistry(registry, 'config.access.registry');
  if (!registryResult.ok) errors.push(...registryResult.errors);

  if (errors.length > 0) {
    const error = new ContractError('invalid plugin config', 'INVALID_REQUEST', errors);
    throw error;
  }
  return {
    maintenance: { enabled: false },
    capture,
    access: { registry: deepClone(registry) },
  };
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// wire helpers
// ---------------------------------------------------------------------------

export function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Build a business success response. Callers must keep the total JSON size
 * under LIMITS.maxResponseJsonBytes on their own boundary.
 */
export function okResponse({ operationId, viewEpoch, scopeGeneration, data }) {
  return {
    schema_version: SCHEMA_VERSION,
    operation_id: operationId,
    view_epoch: viewEpoch,
    scope_generation: scopeGeneration,
    status: 'ok',
    data,
  };
}

export function rejectResponse({ operationId, viewEpoch, scopeGeneration, status, reasonCode }) {
  return {
    schema_version: SCHEMA_VERSION,
    operation_id: operationId,
    view_epoch: viewEpoch,
    scope_generation: scopeGeneration,
    status,
    reason_code: reasonCode,
  };
}

// status <-> reason-code families for mapping service outcomes to the wire.
export const STATUS_FOR_REASON = Object.freeze({
  OWNER_REQUIRED: 'denied',
  CONTEXT_UNBOUND: 'denied',
  SCOPE_REVOKED: 'denied',
  STALE_SCOPE: 'stale',
  STALE_OBSERVATION: 'stale',
  SESSION_UNAVAILABLE: 'unavailable',
  INVALID_REQUEST: 'invalid',
  LIMIT_EXCEEDED: 'invalid',
  UNKNOWN_ENDPOINT: 'invalid',
  OUTPUT_REF_DENIED: 'denied',
  EXPORT_CONFLICT: 'failed',
  OUTCOME_UNKNOWN: 'failed',
  INTERNAL_FAILURE: 'failed',
});

export function responseForReason({ operationId, viewEpoch, scopeGeneration, reasonCode }) {
  const status = STATUS_FOR_REASON[reasonCode] ?? 'failed';
  return rejectResponse({ operationId, viewEpoch, scopeGeneration, status, reasonCode });
}
