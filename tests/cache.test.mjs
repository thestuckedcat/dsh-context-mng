/**
 * T2 bounded observation store: revisions, dedupe, per-session/global bounds,
 * LRU session eviction, subscriptions, invalidation and dispose.
 *
 * No network, no real sessions: fixtures are synthetic ContextObservationV1
 * snapshots built from the same contracts the capture layer must satisfy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ContractError,
  LIMITS,
  validateObservation,
} from '../src/contracts.mjs';
import { createObservationStore } from '../src/observations.mjs';

const CAPTURED_AT = '2026-11-07T00:00:00.000Z';

function hex64(seed = 'observation') {
  const alphabet = '0123456789abcdef';
  let text = '';
  for (let index = 0; index < 64; index += 1) {
    text += alphabet[(seed.charCodeAt(index % seed.length) + index * 7) % 16];
  }
  return text;
}

function scope(overrides = {}) {
  return { scope_id: 'project-a', generation: 3, identity_digest: hex64('project-a'), ...overrides };
}

function boundary(overrides = {}) {
  return {
    session_ref: 'session-a',
    scope: scope(),
    last_event_seq: 4,
    surface_generation: 2,
    route_revision: 'route-unobserved',
    observation_epoch: 0,
    ...overrides,
  };
}

function group(overrides = {}) {
  return {
    group_id: 'user|user|',
    category: 'user',
    source_ref: null,
    source_kind: 'user',
    message_refs: ['msg-1'],
    characters: 5,
    bytes: 5,
    estimated_tokens: 5,
    certainty: 'identified',
    preview: 'hello',
    truncated: false,
    redaction_count: 0,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schema_version: 1,
    observation_id: 'obs-fixture-1',
    revision: 0,
    boundary: boundary(),
    captured_at: CAPTURED_AT,
    capture_stage: 'session_surface',
    fidelity: 'history_projection',
    request_ref: null,
    provider_ref: null,
    model_ref: null,
    observed_digest: hex64('digest'),
    wire_verified: false,
    groups: [group()],
    estimate: {
      method: 'utf8_bytes_estimate_v1',
      tokenizer_ref: null,
      tokens: 5,
      complete: true,
      unpriced_modalities: [],
    },
    reported_usage: null,
    limits: { context_window: null, max_output_tokens: null },
    truncated: false,
    omitted_bytes: 0,
    unavailable_reason: null,
    ...overrides,
  };
}

function putInput(overrides = {}) {
  return {
    session_ref: 'session-a',
    stage: 'session_surface',
    request_ref: null,
    boundary: boundary(),
    observation: observation(),
    ...overrides,
  };
}

/** Large-but-valid group batch: `count` groups, each with `previewChars` preview. */
function groups(count, previewChars = 32) {
  const list = [];
  for (let index = 0; index < count; index += 1) {
    const preview = `${String(index).padStart(4, '0')}-${'x'.repeat(Math.max(0, previewChars - 5))}`;
    list.push(group({
      group_id: `user|user|group-${index}`,
      message_refs: [`msg-${index}`],
      preview,
      characters: previewChars,
      bytes: previewChars,
      estimated_tokens: previewChars,
    }));
  }
  return list;
}

function smallLimits(overrides = {}) {
  return {
    maxObservationsPerSession: 3,
    maxSessionSnapshotBytes: 4096,
    totalCacheBytes: 16384,
    ...overrides,
  };
}

const clock = () => new Date(CAPTURED_AT);

test('revision is per-session monotonic and identical snapshots dedupe', () => {
  const store = createObservationStore({ limits: smallLimits(), clock });
  const first = store.put(putInput());
  assert.equal(first.deduped, false);
  assert.equal(first.revision, 1);
  assert.equal(first.observation.revision, 1);
  assert.equal(first.observation.session_ref, undefined, 'observation shape has no session_ref field');

  const duplicate = store.put(putInput());
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.revision, 1);
  assert.equal(duplicate.observation, first.observation, 'dedupe reuses the stored snapshot object');

  const changed = store.put(putInput({ observation: observation({ observed_digest: hex64('other') }) }));
  assert.equal(changed.deduped, false);
  assert.equal(changed.revision, 2);

  const otherSession = store.put(putInput({
    session_ref: 'session-b',
    boundary: boundary({ session_ref: 'session-b' }),
    observation: observation({
      observation_id: 'obs-b',
      boundary: boundary({ session_ref: 'session-b' }),
    }),
  }));
  assert.equal(otherSession.revision, 1, 'each session has its own revision sequence');

  const latest = store.getLatest('session-a', 'session_surface');
  assert.equal(latest.revision, 2);
  assert.equal(latest.stage, 'session_surface');
  assert.equal(latest.session_ref, 'session-a');
  assert.equal(latest.observation.observation_id, 'obs-fixture-1');
  assert.equal(store.getLatest('session-b', 'session_surface').revision, 1);
  assert.equal(store.getLatest('session-a', 'llm_waterfall'), null);
  store.dispose();
});

test('dedupe separates capture stages and request refs', () => {
  const store = createObservationStore({ limits: smallLimits(), clock });
  const surface = store.put(putInput());
  const preStep = store.put(putInput({ stage: 'agent_pre_step' }));
  assert.equal(surface.revision, 1);
  assert.equal(preStep.revision, 2, 'same content under another stage is a new revision');

  const reqA = store.put(putInput({ stage: 'llm_waterfall', request_ref: 'req-1' }));
  assert.equal(reqA.revision, 3);
  const reqADuplicate = store.put(putInput({ stage: 'llm_waterfall', request_ref: 'req-1' }));
  assert.equal(reqADuplicate.deduped, true);
  assert.equal(reqADuplicate.revision, 3);

  const reqB = store.put(putInput({ stage: 'llm_waterfall', request_ref: 'req-2' }));
  assert.equal(reqB.revision, 4, 'a different request ref is never deduped');
  assert.equal(reqB.deduped, false);
  store.dispose();
});

test('put does not mutate the caller observation and stores internal revisions', () => {
  const store = createObservationStore({ limits: smallLimits(), clock });
  const input = putInput({ observation: observation({ revision: 999 }) });
  const frozenBoundary = JSON.stringify(input.boundary);
  const result = store.put(input);
  assert.equal(result.observation.revision, 1);
  assert.equal(input.observation.revision, 999, 'caller object is not mutated');
  assert.equal(JSON.stringify(input.boundary), frozenBoundary);
  const stored = store.getByObservationId('obs-fixture-1');
  assert.equal(stored.revision, 1);
  assert.notEqual(stored.observation, input.observation, 'stored snapshot is a detached copy');
  store.dispose();
});

test('entriesForSession is revision ordered; unknown observation ids resolve to null', () => {
  const store = createObservationStore({ limits: smallLimits(), clock });
  store.put(putInput({ observation: observation({ observation_id: 'obs-1' }) }));
  store.put(putInput({ observation: observation({ observation_id: 'obs-2', observed_digest: hex64('d2') }) }));
  const entries = store.entriesForSession('session-a');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.revision), [1, 2]);
  assert.equal(store.getByObservationId('obs-2').revision, 2);
  assert.equal(store.getByObservationId('obs-missing'), null);
  assert.equal(store.getByObservationId('obs-2').observation.observation_id, 'obs-2');
  store.dispose();
});

test('per-session snapshot cap evicts the oldest revisions first', () => {
  const store = createObservationStore({ limits: smallLimits({ maxObservationsPerSession: 3 }), clock });
  for (let index = 0; index < 6; index += 1) {
    store.put(putInput({ observation: observation({ observation_id: `obs-${index}`, observed_digest: hex64(`digest-${index}`) }) }));
  }
  const entries = store.entriesForSession('session-a');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.revision), [4, 5, 6]);
  assert.equal(store.getByObservationId('obs-0'), null, 'evicted observation ids are reported stale');
  assert.equal(store.getLatest('session-a', 'session_surface').revision, 6);
  assert.equal(store.stats().entries, 3);
  store.dispose();
});

test('snapshot byte cap trims previews with honest truncation flags', () => {
  const store = createObservationStore({ limits: smallLimits({ maxSessionSnapshotBytes: 4096 }), clock });
  const result = store.put(putInput({
    observation: observation({
      groups: groups(12, 300),
      estimate: { method: 'utf8_bytes_estimate_v1', tokenizer_ref: null, tokens: 3600, complete: true, unpriced_modalities: [] },
    }),
  }));
  const stored = result.observation;
  const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
  assert.ok(bytes <= 4096, `stored snapshot must fit the session budget (got ${bytes})`);
  assert.equal(stored.truncated, true);
  assert.ok(stored.omitted_bytes >= 0);
  assert.ok(stored.groups.length > 0 && stored.groups.length <= 12);
  const trimmed = stored.groups.filter((item) => item.truncated === true);
  assert.ok(trimmed.length > 0, 'at least one preview is marked truncated instead of silently shortened');
  for (const item of stored.groups) {
    assert.ok(item.preview.length <= LIMITS.maxPreviewChars);
  }
  assert.equal(validateObservation(stored).ok, true);
  assert.match(stored.observed_digest, /^[0-9a-f]{64}$/, 'trimmed snapshot digest is recomputed, not the untrimmed one');
  store.dispose();
});

test('snapshot byte cap drops tail groups when preview trimming is insufficient, without faking completeness', () => {
  const store = createObservationStore({ limits: smallLimits({ maxSessionSnapshotBytes: 4096 }), clock });
  const result = store.put(putInput({
    observation: observation({
      groups: groups(200, 64),
      estimate: { method: 'utf8_bytes_estimate_v1', tokenizer_ref: null, tokens: 12800, complete: true, unpriced_modalities: [] },
    }),
  }));
  const stored = result.observation;
  const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
  assert.ok(bytes <= 4096, `stored snapshot must fit the session budget (got ${bytes})`);
  assert.equal(stored.truncated, true);
  assert.ok(stored.groups.length < 200);
  assert.ok(stored.omitted_bytes > 0, 'dropped groups are counted as omitted bytes');
  assert.equal(stored.estimate.complete, false, 'a dropped-group snapshot must not claim a complete estimate');
  assert.equal(stored.estimate.tokens, null, 'unknown token total is null rather than a wrong number');
  assert.equal(validateObservation(stored).ok, true);
  store.dispose();
});

test('default limits keep at most 8 snapshots and trim a single 2 MiB session snapshot', () => {
  const store = createObservationStore({ limits: LIMITS, clock });
  for (let index = 0; index < 10; index += 1) {
    store.put(putInput({ observation: observation({ observation_id: `obs-${index}`, observed_digest: hex64(`digest-${index}`) }) }));
  }
  assert.equal(store.entriesForSession('session-a').length, 8);
  assert.equal(store.entriesForSession('session-a').at(-1).revision, 10);

  const big = store.put(putInput({
    boundary: boundary({ last_event_seq: 99 }),
    observation: observation({
      observation_id: 'obs-big',
      observed_digest: hex64('big'),
      boundary: boundary({ last_event_seq: 99 }),
      groups: groups(5000, 512),
      estimate: { method: 'utf8_bytes_estimate_v1', tokenizer_ref: null, tokens: 2560000, complete: true, unpriced_modalities: [] },
    }),
  }));
  const stored = big.observation;
  const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
  assert.ok(bytes <= LIMITS.maxSessionSnapshotBytes, `single snapshot must fit 2 MiB (got ${bytes})`);
  assert.equal(stored.truncated, true);
  assert.equal(validateObservation(stored).ok, true);
  store.dispose();
});

test('total cache limit evicts whole least-recently-used sessions', () => {
  const limits = smallLimits({
    maxObservationsPerSession: 2,
    maxSessionSnapshotBytes: 4096,
    // Each fixture snapshot serializes to ~1.5 KiB: two sessions fit, three do not.
    totalCacheBytes: 3600,
  });
  const store = createObservationStore({ limits, clock });
  const makeEntry = (session, previewChars) => ({
    session_ref: session,
    stage: 'session_surface',
    request_ref: null,
    boundary: boundary({ session_ref: session }),
    observation: observation({
      observation_id: `obs-${session}`,
      boundary: boundary({ session_ref: session }),
      groups: groups(1, previewChars),
    }),
  });
  store.put(makeEntry('session-a', 400));
  store.put(makeEntry('session-b', 400));
  assert.ok(store.stats().bytes <= 3600);
  store.put(makeEntry('session-c', 400));
  const sessions = store.stats().sessions;
  assert.ok(store.stats().bytes <= 3600, `global cache must stay bounded (got ${store.stats().bytes})`);
  assert.equal(store.getLatest('session-a', 'session_surface'), null, 'least recently used session is evicted');
  assert.equal(store.getLatest('session-b', 'session_surface').session_ref, 'session-b');
  assert.equal(store.getLatest('session-c', 'session_surface').session_ref, 'session-c');

  // Touch session-b, then insert session-d: session-c (now coldest) is evicted.
  store.getLatest('session-b', 'session_surface');
  store.put(makeEntry('session-d', 400));
  assert.equal(store.getLatest('session-c', 'session_surface'), null);
  assert.equal(store.getLatest('session-b', 'session_surface').session_ref, 'session-b');
  assert.equal(store.getLatest('session-d', 'session_surface').session_ref, 'session-d');
  assert.equal(store.stats().sessions, sessions);
  store.dispose();
});

test('invalidateSession clears bodies and keeps the revision sequence monotonic', () => {
  const store = createObservationStore({ limits: smallLimits(), clock });
  const notifications = [];
  const unsubscribe = store.subscribe('session-a', (event) => notifications.push(event));
  const first = store.put(putInput());
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].revision, first.revision);

  store.invalidateSession('session-a');
  assert.equal(store.getLatest('session-a', 'session_surface'), null);
  assert.deepEqual(store.entriesForSession('session-a'), []);
  assert.equal(notifications.at(-1).invalidated, true);

  const afterInvalidation = store.put(putInput({ observation: observation({ observed_digest: hex64('after') }) }));
  assert.ok(afterInvalidation.revision > first.revision, 'revision never goes backwards after invalidation');
  assert.equal(afterInvalidation.deduped, false);
  unsubscribe();
  store.dispose();
});

test('subscribe notifies only new revisions and contains listener failures', () => {
  const store = createObservationStore({ limits: smallLimits(), clock });
  const seen = [];
  store.subscribe('session-a', () => { throw new Error('listener must not break put'); });
  const unsubscribe = store.subscribe('session-a', (event) => seen.push(event.revision));
  store.put(putInput());
  store.put(putInput());
  assert.deepEqual(seen, [1], 'dedupe creates no new revision and sends no notification');
  store.put(putInput({ observation: observation({ observed_digest: hex64('new') }) }));
  assert.deepEqual(seen, [1, 2]);
  unsubscribe();
  store.put(putInput({ observation: observation({ observed_digest: hex64('later') }) }));
  assert.deepEqual(seen, [1, 2], 'unsubscribe stops notifications');
  store.dispose();
});

test('trimmed snapshots are still structurally valid and deterministic', () => {
  const store = createObservationStore({ limits: smallLimits({ maxSessionSnapshotBytes: 2048 }), clock });
  const inputGroups = groups(40, 100);
  const a = store.put(putInput({ observation: observation({ groups: inputGroups }) }));
  const bStore = createObservationStore({ limits: smallLimits({ maxSessionSnapshotBytes: 2048 }), clock });
  const b = bStore.put(putInput({ observation: observation({ groups: inputGroups }) }));
  assert.equal(validateObservation(a.observation).ok, true);
  assert.equal(a.observation.observed_digest, b.observation.observed_digest, 'same trimmed content hashes identically');
  assert.equal(
    Buffer.byteLength(JSON.stringify(a.observation), 'utf8'),
    Buffer.byteLength(JSON.stringify(b.observation), 'utf8'),
  );
  store.dispose();
  bStore.dispose();
});

test('dispose clears all bodies and refuses further writes', () => {
  const store = createObservationStore({ limits: smallLimits(), clock });
  store.put(putInput());
  assert.ok(store.stats().bytes > 0);
  store.dispose();
  assert.equal(store.getLatest('session-a', 'session_surface'), null);
  assert.equal(store.getByObservationId('obs-fixture-1'), null);
  assert.deepEqual(store.entriesForSession('session-a'), []);
  assert.equal(store.stats().bytes, 0);
  assert.throws(() => store.put(putInput()), (error) => error instanceof ContractError);
  store.dispose();
});

test('invalid observations are rejected rather than cached', () => {
  const store = createObservationStore({ limits: smallLimits(), clock });
  assert.throws(
    () => store.put(putInput({ observation: { schema_version: 2 } })),
    (error) => error instanceof ContractError,
  );
  assert.throws(
    () => store.put(putInput({ session_ref: '' })),
    (error) => error instanceof ContractError,
  );
  assert.throws(
    () => store.put(putInput({ stage: 'not-a-stage' })),
    (error) => error instanceof ContractError,
  );
  assert.equal(store.stats().entries, 0);
  store.dispose();
});
