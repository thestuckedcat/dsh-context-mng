#!/usr/bin/env node
/**
 * 07 context-mng: local read-only report CLI (design §5.2 fallback).
 *
 *   node tools/context-report.mjs --fixture [--out <path under $env:TEMP>]
 *   node tools/context-report.mjs --session-ref <ref>   # always refuses
 *
 * `--fixture` builds two synthetic rc.5-shaped sessions A and B through the
 * real pure core (`projection.mjs` + `redact.mjs` + `access.mjs`), validates the
 * resulting ContextObservationV1 and ReportV1 with `contracts.mjs`, proves the
 * A/B isolation negatives at the access/projection boundary, and prints the
 * canonical JSON report for session A to stdout.
 *
 * `--session-ref` exists only to state the fallback rule explicitly: this CLI
 * MUST NOT scan the host's persisted session directory as some kind of
 * substitute for authenticated Host RPC/CLI. A real session can only be read
 * through the running Host's authorized surface.
 *
 * This CLI never touches the network, never reads a real session, and only
 * writes when `--out` resolves inside the OS temp area (through the atomic
 * export writer).
 */

import path from 'node:path';

import {
  LIMITS,
  REDACTION_POLICY_REVISION,
  SCHEMA_VERSION,
  canonicalJson,
  validateObservation,
  validateReport,
} from '../src/contracts.mjs';
import { createAccessRegistry } from '../src/access.mjs';
import { projectMessages } from '../src/projection.mjs';
import { createRedactor } from '../src/redact.mjs';
import { createReportWriter } from '../src/export.mjs';

const TOOL = 'context-report';
const FIXTURE_CLOCK = '2026-11-07T00:00:00.000Z';
const POLICY = { redactionPolicyRevision: REDACTION_POLICY_REVISION };

const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  REFUSED: 3,
  INVALID: 4,
  CONFLICT: 5,
});

function fail(code, message) {
  process.stderr.write(`${TOOL}: ${message}\n`);
  process.exit(code);
}

function usage() {
  process.stderr.write(
    [
      `usage: node tools/${TOOL}.mjs --fixture [--out <path under $env:TEMP>]`,
      `       node tools/${TOOL}.mjs --session-ref <ref>   (refused by design)`,
      '',
      'Prints the canonical read-only report for two synthetic sessions (A/B);',
      'no real session content is read and no network/disk side effect happens',
      'unless --out points inside the OS temp area.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const options = { fixture: false, out: null, sessionRef: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') options.fixture = true;
    else if (arg === '--out') {
      index += 1;
      if (index >= argv.length) fail(EXIT.USAGE, '--out requires a path value');
      options.out = argv[index];
    } else if (arg === '--session-ref') {
      index += 1;
      if (index >= argv.length) fail(EXIT.USAGE, '--session-ref requires a value');
      options.sessionRef = argv[index];
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(EXIT.OK);
    } else {
      fail(EXIT.USAGE, `unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// synthetic rc.5-shaped sessions (never real data)
// ---------------------------------------------------------------------------

const TINY_PNG = Object.freeze({
  attachmentId: `sha256:${'b'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 1024,
  width: 4,
  height: 4,
});

const FAKE_KEY = 'sk-proj-FAKE0123456789abcdefABCDEF';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.FAKEsignatureFAKEsignature';
const FAKE_PASSWORD = 'Synthetic-Passw0rd-77';
const B_MARKER = 'SESSION-B-ONLY-MARKER';

function text(value) {
  return { type: 'text', text: value };
}

function message(id, role, content, source) {
  return { id, role, content, source };
}

function syntheticSessionA() {
  return {
    session_ref: 'session-fixture-a',
    scope: {
      scope_id: 'scope-fixture-a',
      generation: 4,
      identity_digest: 'a'.repeat(64),
    },
    cwd: 'C:/synthetic/project-a',
    messages: [
      message('a-01', 'system', [text('You are a synthetic fixture assistant for project A.')], { kind: 'system-prompt' }),
      message('a-02', 'developer', [text('Use the synthetic fixture workflow.')], { kind: 'skill-invocation', name: 'fixture-skill', form: 'instructions' }),
      message('a-03', 'user', [text(`Deploy with ${FAKE_KEY} and password = "${FAKE_PASSWORD}".`)], { kind: 'user' }),
      message('a-04', 'assistant', [
        { type: 'reasoning', text: 'Synthetic reasoning only.' },
        { type: 'tool-call', id: 'call-a1', name: 'read_fixture', arguments: '{"path":"fixture.json"}' },
      ], { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }),
      message('a-05', 'tool', [text('{"ok":true,"value":"fixture-a"}')], { kind: 'tool', callId: 'call-a1' }),
      message('a-06', 'user', [
        text('Synthetic dashboard screenshot:'),
        { type: 'image', attachment: TINY_PNG },
      ], { kind: 'user' }),
      message('a-07', 'mystery', [text('Unlabelled synthetic note; body words like memory or secret do not classify it.')], undefined),
      message('a-08', 'user', [text(`synthetic bearer credential: ${FAKE_JWT}`)], { kind: 'user' }),
    ],
    tool_definitions: [
      {
        name: 'read_fixture',
        description: 'Read a synthetic fixture file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
  };
}

function syntheticSessionB() {
  return {
    session_ref: 'session-fixture-b',
    scope: {
      scope_id: 'scope-fixture-b',
      generation: 9,
      identity_digest: 'b'.repeat(64),
    },
    cwd: 'C:/synthetic/project-b',
    messages: [
      message('b-01', 'system', [text('You are a synthetic fixture assistant for project B.')], { kind: 'system-prompt' }),
      message('b-02', 'user', [text(`${B_MARKER} should never appear in an A report.`)], { kind: 'user' }),
    ],
    tool_definitions: [],
  };
}

function accessRegistryFixture(a, b, exportRootPath) {
  return {
    schema_version: SCHEMA_VERSION,
    revision: 1,
    bindings: [
      {
        context_ref: 'ctx-fixture-a',
        session_ref: a.session_ref,
        scope: a.scope,
        read: true,
        export_root_refs: ['reports'],
        active: true,
      },
      {
        context_ref: 'ctx-fixture-b',
        session_ref: b.session_ref,
        scope: b.scope,
        read: true,
        export_root_refs: ['reports'],
        active: true,
      },
    ],
    export_roots: [{ root_ref: 'reports', path: exportRootPath }],
  };
}

function observationFor(session, projection) {
  const capturedAt = FIXTURE_CLOCK;
  return {
    schema_version: SCHEMA_VERSION,
    observation_id: `obs-${session.session_ref}`,
    revision: 1,
    boundary: {
      session_ref: session.session_ref,
      scope: session.scope,
      last_event_seq: session.messages.length,
      surface_generation: 1,
      route_revision: 'route-fixture-1',
      observation_epoch: 0,
    },
    captured_at: capturedAt,
    capture_stage: 'session_surface',
    fidelity: 'history_projection',
    request_ref: null,
    provider_ref: null,
    model_ref: null,
    observed_digest: projection.observed_digest,
    wire_verified: false,
    groups: projection.groups,
    estimate: projection.estimate,
    reported_usage: {
      request_ref: `request-${session.session_ref}`,
      input_tokens: 2048,
      output_tokens: 256,
      cached_input_tokens: 512,
      source: 'provider_usage_chunk',
      is_final: true,
    },
    limits: { context_window: 128000, max_output_tokens: 8192 },
    truncated: projection.truncated,
    omitted_bytes: projection.omitted_bytes,
    unavailable_reason: null,
  };
}

function reportFor(observation) {
  return {
    schema_version: SCHEMA_VERSION,
    capability: '07',
    report_id: `ctx-report-${observation.observation_id}-r1`,
    exported_at: FIXTURE_CLOCK,
    observation,
    redaction_policy_revision: REDACTION_POLICY_REVISION,
  };
}

// ---------------------------------------------------------------------------
// isolation proof at the access boundary (A cannot read B)
// ---------------------------------------------------------------------------

function probeIsolation(access, a, b) {
  const lines = [];
  const owner = { kind: 'owner', peer_id: 'synthetic-owner' };
  const bindingA = access.checkContext({ caller: owner, contextRef: 'ctx-fixture-a', expectedScopeGeneration: a.scope.generation });
  lines.push(`binding A -> ${bindingA.session_ref}`);
  const bindingB = access.checkContext({ caller: owner, contextRef: 'ctx-fixture-b', expectedScopeGeneration: b.scope.generation });
  lines.push(`binding B -> ${bindingB.session_ref}`);

  const expectDenied = (label, fn, reasonCode) => {
    try {
      fn();
      fail(EXIT.INVALID, `A/B isolation negative not enforced: ${label}`);
    } catch (error) {
      if (error.code === 'EXIT') throw error;
      if (error.reasonCode !== reasonCode) {
        fail(EXIT.INVALID, `A/B isolation negative ${label} produced ${error.reasonCode} instead of ${reasonCode}`);
      }
      lines.push(`denied ${label}: ${error.reasonCode}`);
    }
  };

  // 1. Context A cannot be opened with B's scope generation.
  expectDenied('A+generation(B)', () => {
    access.checkContext({ caller: owner, contextRef: 'ctx-fixture-a', expectedScopeGeneration: b.scope.generation });
  }, 'STALE_SCOPE');
  // 2. A model/other principal can never obtain any binding.
  expectDenied('model-principal', () => {
    access.checkContext({ caller: { kind: 'model' }, contextRef: 'ctx-fixture-a', expectedScopeGeneration: a.scope.generation });
  }, 'OWNER_REQUIRED');
  // 3. Unknown contexts are unbound, not implicitly readable.
  expectDenied('unknown-context', () => {
    access.checkContext({ caller: owner, contextRef: 'ctx-fixture-unknown', expectedScopeGeneration: 1 });
  }, 'CONTEXT_UNBOUND');
  // 4. Export output refs are joined to the binding.
  expectDenied('export-ref-not-registered', () => {
    access.checkExport({ caller: owner, contextRef: 'ctx-fixture-a', expectedScopeGeneration: a.scope.generation, outputRef: 'secrets' });
  }, 'OUTPUT_REF_DENIED');
  return lines;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function resolveTempOutput(candidate) {
  const tempRoot = process.env.TEMP || process.env.TMP;
  if (!tempRoot) fail(EXIT.REFUSED, 'refusing --out: the OS temp directory is not available');
  const absolute = path.resolve(candidate);
  const tempResolved = path.resolve(tempRoot);
  const relative = path.relative(tempResolved, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(EXIT.REFUSED, `refusing --out ${JSON.stringify(candidate)}: only paths inside $env:TEMP are writable`);
  }
  return { absolute, root: path.dirname(absolute), fileName: path.basename(absolute) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.sessionRef !== null) {
    // Design fallback rule: a CLI MUST NOT read a real session from the host's
    // persisted directory. Only authenticated Host RPC/CLI can supply it.
    fail(
      EXIT.REFUSED,
      [
        'refusing --session-ref: a real session can only be read through the running Harness Host',
        'with authenticated Host RPC/CLI (the plugin connection channel / the Host UI);',
        'direct reads of the persisted session directory are not an authorized fallback.',
        'Use --fixture for the synthetic read-only report.',
      ].join(' '),
    );
  }
  if (!options.fixture) {
    usage();
    fail(EXIT.USAGE, 'no source selected (expected --fixture; --session-ref is always refused)');
  }

  const sessionA = syntheticSessionA();
  const sessionB = syntheticSessionB();
  const access = createAccessRegistry({
    registry: accessRegistryFixture(sessionA, sessionB, path.join(process.env.TEMP || '.', 'dsh07-fixture-reports')),
  });

  try {
    const isolation = probeIsolation(access, sessionA, sessionB);
    for (const line of isolation) process.stderr.write(`${TOOL}: ${line}\n`);
  } finally {
    access.dispose();
  }

  const redactor = createRedactor({ policyRevision: REDACTION_POLICY_REVISION });
  const projectionA = projectMessages({
    messages: sessionA.messages,
    tool_definitions: sessionA.tool_definitions,
    policy: { redactionPolicyRevision: REDACTION_POLICY_REVISION, redactor },
    limits: LIMITS,
  });
  const observationA = observationFor(sessionA, projectionA);
  const observationCheck = validateObservation(observationA);
  if (!observationCheck.ok) {
    process.stderr.write(`${TOOL}: observation failed contract validation: ${JSON.stringify(observationCheck.errors.slice(0, 5))}\n`);
    process.exit(EXIT.INVALID);
  }
  const report = reportFor(observationA);
  const reportCheck = validateReport(report);
  if (!reportCheck.ok) {
    process.stderr.write(`${TOOL}: report failed contract validation: ${JSON.stringify(reportCheck.errors.slice(0, 5))}\n`);
    process.exit(EXIT.INVALID);
  }

  const serialized = canonicalJson(report);
  // Fixture canaries: fake credentials must be redacted, unknown stays unknown,
  // and B's content must not leak into A's report.
  const canaries = [FAKE_KEY, FAKE_JWT, FAKE_PASSWORD, B_MARKER, 'SESSION-B'];
  for (const canary of canaries) {
    if (serialized.includes(canary)) fail(EXIT.INVALID, `fixture invariant failed: report contains ${JSON.stringify(canary.slice(0, 8) + '…')}`);
  }
  if (B_MARKER.length > 0 && serialized.includes('project-b') === false) {
    // Not an error: A's report may legitimately omit all B identifiers; this
    // branch only documents that absence is the expected direction.
  }
  const unknownGroup = report.observation.groups.find((group) => group.category === 'unknown');
  if (unknownGroup === undefined) fail(EXIT.INVALID, 'fixture invariant failed: unknown-source content was not kept unknown');
  if (report.observation.reported_usage === null) fail(EXIT.INVALID, 'fixture invariant failed: provider usage missing');

  // Projection estimates and provider usage stay separate fields.
  const providerTotal = report.observation.reported_usage.input_tokens;
  if (report.observation.estimate.tokens !== null && report.observation.estimate.tokens === providerTotal) {
    fail(EXIT.INVALID, 'fixture invariant failed: estimate appears to mirror provider usage');
  }

  if (options.out !== null) {
    const target = resolveTempOutput(options.out);
    const writer = createReportWriter({});
    const written = writer.writeReport({ rootPath: target.root, report, fileName: target.fileName });
    process.stderr.write(`${TOOL}: wrote ${written.report_ref} status=${written.status} digest=${written.digest}\n`);
    if (written.status === 'conflict') fail(EXIT.CONFLICT, 'an existing different report already occupies --out; refusing to overwrite');
  }

  process.stdout.write(`${serialized}\n`);
  return EXIT.OK;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${TOOL}: unexpected failure: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT.INVALID);
  },
);
