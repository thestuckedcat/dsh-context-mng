/** Shared synthetic fixtures for 07 component tests. No real session data. */

import { LIMITS, REDACTION_POLICY_REVISION, SCHEMA_VERSION } from '../src/contracts.mjs';

export const HOUR_ISO = '2026-11-07T00:00:00.000Z';

export function digest(seed = 'scope') {
  const hex = '0123456789abcdef';
  let text = '';
  for (let index = 0; index < 64; index += 1) {
    text += hex[(seed.charCodeAt(index % seed.length) + index * 7) % 16];
  }
  return text;
}

export function scopeRef(overrides = {}) {
  return {
    scope_id: 'project-a',
    generation: 3,
    identity_digest: digest('project-a'),
    ...overrides,
  };
}

export function binding(overrides = {}) {
  return {
    context_ref: 'ctx-a',
    session_ref: 'session-a',
    scope: scopeRef(),
    read: true,
    export_root_refs: ['reports'],
    active: true,
    ...overrides,
  };
}

export function registry(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    revision: 7,
    bindings: [binding()],
    export_roots: [{ root_ref: 'reports', path: 'C:/Users/synthetic/context-reports' }],
    ...overrides,
  };
}

export function boundary(overrides = {}) {
  return {
    session_ref: 'session-a',
    scope: scopeRef(),
    last_event_seq: 4,
    surface_generation: 2,
    route_revision: 'route-1',
    observation_epoch: 1,
    ...overrides,
  };
}

export function group(overrides = {}) {
  return {
    group_id: 'system|system-prompt|',
    category: 'system',
    source_ref: null,
    source_kind: 'system-prompt',
    message_refs: ['msg-system'],
    characters: 12,
    bytes: 12,
    estimated_tokens: 12,
    certainty: 'identified',
    preview: 'You are helpful.',
    truncated: false,
    redaction_count: 0,
    ...overrides,
  };
}

export function estimate(overrides = {}) {
  return {
    method: 'utf8_bytes_estimate_v1',
    tokenizer_ref: null,
    tokens: 24,
    complete: true,
    unpriced_modalities: [],
    ...overrides,
  };
}

export function observation(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    observation_id: 'obs-fixture-1',
    revision: 1,
    boundary: boundary(),
    captured_at: HOUR_ISO,
    capture_stage: 'session_surface',
    fidelity: 'history_projection',
    request_ref: null,
    provider_ref: null,
    model_ref: null,
    observed_digest: digest('observation'),
    wire_verified: false,
    groups: [group()],
    estimate: estimate(),
    reported_usage: null,
    limits: { context_window: 128000, max_output_tokens: 8192 },
    truncated: false,
    omitted_bytes: 0,
    unavailable_reason: null,
    ...overrides,
  };
}

export function report(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    capability: '07',
    report_id: 'ctx-report-fixture-1',
    exported_at: HOUR_ISO,
    observation: observation(),
    redaction_policy_revision: REDACTION_POLICY_REVISION,
    ...overrides,
  };
}

export function fixedClock(iso = HOUR_ISO) {
  return () => new Date(iso);
}

/** Minimal in-memory store double for service tests. */
export function memoryStore(entries = []) {
  const list = [...entries];
  return {
    list,
    getLatest(sessionRef, stage) {
      const matches = list.filter((entry) => entry.session_ref === sessionRef && entry.stage === stage);
      return matches.length === 0 ? null : matches[matches.length - 1];
    },
    getByObservationId(observationId) {
      return list.find((entry) => entry.observation.observation_id === observationId) ?? null;
    },
    stats() {
      return { entries: list.length, bytes: 0, sessions: new Set(list.map((entry) => entry.session_ref)).size };
    },
    dispose() {},
  };
}

export function storeEntry(overrides = {}) {
  return {
    session_ref: 'session-a',
    stage: 'session_surface',
    revision: 1,
    boundary: boundary(),
    observation: observation(),
    ...overrides,
  };
}

export function captureDouble(overrides = {}) {
  return {
    calls: [],
    async captureSurface(input) {
      this.calls.push(['captureSurface', input]);
      return { status: 'ok', observation: observation() };
    },
    async readGroupTexts(input) {
      this.calls.push(['readGroupTexts', input]);
      return {
        status: 'ok',
        groups: new Map([['system|system-prompt|', { text: 'You are helpful.', characters: 17, bytes: 17, redaction_count: 0 }]]),
      };
    },
    ...overrides,
  };
}

export function reportWriterDouble(overrides = {}) {
  return {
    calls: [],
    async writeReport(input) {
      this.calls.push(input);
      return { status: 'saved', report_ref: 'reports/ctx-report-fixture-1.json', digest: digest('report') };
    },
    ...overrides,
  };
}

export { LIMITS };
