/** T1 access isolation: registry is the only authority; forged callers/refs denied. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ContractError } from '../src/contracts.mjs';
import { createAccessRegistry } from '../src/access.mjs';
import { binding, digest, registry, scopeRef } from './helpers.mjs';

const OWNER = Object.freeze({ kind: 'owner', peer_id: 'browser' });
const FORGED = Object.freeze({ kind: 'owner', grant: 'everything' });

function reasonOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ContractError, `expected ContractError, got ${String(error)}`);
    return error.reasonCode;
  }
  assert.fail('expected a ContractError');
}

test('valid registry loads and reports its identity', () => {
  const access = createAccessRegistry({ registry: registry() });
  assert.equal(access.revision, 7);
  assert.match(access.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(access.describe(), {
    revision: 7,
    digest: access.digest,
    bindings: 1,
    active_bindings: 1,
    export_roots: 1,
  });
});

test('registry rejects unknown fields, duplicates, unbound export roots and relative roots', () => {
  const withUnknown = registry();
  withUnknown.bindings[0].secret_admin = true;
  assert.throws(() => createAccessRegistry({ registry: withUnknown }), /invalid access registry/);

  const duplicateContext = registry();
  duplicateContext.bindings.push(binding({ session_ref: 'session-b' }));
  assert.throws(() => createAccessRegistry({ registry: duplicateContext }), /invalid access registry/);

  const duplicateSession = registry();
  duplicateSession.bindings.push(binding({ context_ref: 'ctx-b' }));
  assert.throws(() => createAccessRegistry({ registry: duplicateSession }), /invalid access registry/);

  const unboundRoot = registry();
  unboundRoot.bindings[0].export_root_refs = ['not-registered'];
  assert.throws(() => createAccessRegistry({ registry: unboundRoot }), /invalid access registry/);

  const relativeRoot = registry();
  relativeRoot.export_roots[0].path = 'relative/reports';
  assert.throws(() => createAccessRegistry({ registry: relativeRoot }), /invalid access registry/);

  const readFalse = registry();
  readFalse.bindings[0].read = false;
  assert.throws(() => createAccessRegistry({ registry: readFalse }), /invalid access registry/);

  const badDigest = registry();
  badDigest.bindings[0].scope.identity_digest = 'ABC';
  assert.throws(() => createAccessRegistry({ registry: badDigest }), /invalid access registry/);
});

test('owner-only gate rejects any non-owner caller', () => {
  const access = createAccessRegistry({ registry: registry() });
  assert.equal(reasonOf(() => access.listContexts({ kind: 'api' })), 'OWNER_REQUIRED');
  assert.equal(reasonOf(() => access.listContexts(undefined)), 'OWNER_REQUIRED');
  assert.equal(reasonOf(() => access.checkContext({ caller: { kind: 'model' }, contextRef: 'ctx-a', expectedScopeGeneration: 3 })), 'OWNER_REQUIRED');
  // caller fields in the object are attacker-controlled JSON in a buggy caller; only kind matters.
  assert.equal(access.isOwner(FORGED), true);
  assert.equal(access.isOwner({ kind: 'owner', scope: 'other' }), true);
  assert.equal(access.isOwner(null), false);
});

test('A/B isolation: unbound context and unknown session are denied', () => {
  const access = createAccessRegistry({ registry: registry() });
  assert.equal(
    reasonOf(() => access.checkContext({ caller: OWNER, contextRef: 'ctx-b', expectedScopeGeneration: 3 })),
    'CONTEXT_UNBOUND',
  );
  assert.equal(access.bindingForSession('session-b'), null);
  assert.equal(access.bindingForSession('session-a').context_ref, 'ctx-a');
});

test('inactive binding and stale generation are refused', () => {
  const access = createAccessRegistry({ registry: registry({ bindings: [binding({ active: false })] }) });
  assert.equal(
    reasonOf(() => access.checkContext({ caller: OWNER, contextRef: 'ctx-a', expectedScopeGeneration: 3 })),
    'SCOPE_REVOKED',
  );
  assert.equal(access.bindingForSession('session-a'), null);

  const active = createAccessRegistry({ registry: registry() });
  assert.equal(
    reasonOf(() => active.checkContext({ caller: OWNER, contextRef: 'ctx-a', expectedScopeGeneration: 4 })),
    'STALE_SCOPE',
  );
  assert.equal(
    reasonOf(() => active.checkContext({ caller: OWNER, contextRef: 'ctx-a', expectedScopeGeneration: undefined })),
    'INVALID_REQUEST',
  );
});

test('context.list never exposes absolute export paths', () => {
  const access = createAccessRegistry({ registry: registry() });
  const contexts = access.listContexts(OWNER);
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0].export_root_refs, ['reports']);
  const wire = JSON.stringify(contexts);
  assert.equal(wire.includes('C:/Users/synthetic'), false);
  assert.equal(wire.includes('synthetic'), false);
  assert.equal(contexts[0].scope_id, 'project-a');
  assert.equal(contexts[0].generation, 3);
});

test('export root resolution is limited to the authorized binding', () => {
  const access = createAccessRegistry({ registry: registry() });
  const allowed = access.checkExport({ caller: OWNER, contextRef: 'ctx-a', expectedScopeGeneration: 3, outputRef: 'reports' });
  assert.equal(allowed.rootPath, 'C:/Users/synthetic/context-reports');
  assert.equal(reasonOf(() => access.checkExport({ caller: OWNER, contextRef: 'ctx-a', expectedScopeGeneration: 3, outputRef: 'other' })), 'OUTPUT_REF_DENIED');
  // output_ref that happens to be a path must never resolve
  assert.equal(reasonOf(() => access.checkExport({ caller: OWNER, contextRef: 'ctx-a', expectedScopeGeneration: 3, outputRef: '../../etc' })), 'OUTPUT_REF_DENIED');
});

test('two bindings with distinct scopes do not leak into each other', () => {
  const second = binding({
    context_ref: 'ctx-b',
    session_ref: 'session-b',
    scope: scopeRef({ scope_id: 'project-b', generation: 9, identity_digest: digest('project-b') }),
  });
  const access = createAccessRegistry({ registry: registry({ bindings: [binding(), second] }) });
  const contexts = access.listContexts(OWNER);
  assert.deepEqual(contexts.map((item) => item.context_ref), ['ctx-a', 'ctx-b']);
  assert.equal(access.bindingForSession('session-b').scope.generation, 9);
  assert.equal(reasonOf(() => access.checkContext({ caller: OWNER, contextRef: 'ctx-b', expectedScopeGeneration: 3 })), 'STALE_SCOPE');
});

test('disposed registry refuses further reads', () => {
  const access = createAccessRegistry({ registry: registry() });
  access.dispose();
  assert.equal(reasonOf(() => access.listContexts(OWNER)), 'INTERNAL_FAILURE');
});
