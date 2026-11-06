/**
 * Trusted access registry for 07 context observation.
 *
 * The registry is the ONLY source of authorized context bindings. It is loaded
 * from explicit, user-owned plugin configuration at activation time and is
 * never derived from model output, message text, session cwd strings, frontend
 * routes or request payloads. The browser client cannot self-grant a binding:
 * every request is joined back to this registry by `context_ref`, and the
 * `caller` object is injected by the Host RPC boundary from the real peer
 * principal, never read from JSON.
 */

import {
  ContractError,
  canonicalJson,
  deepClone,
  sha256Hex,
  validateAccessRegistry,
  isSafeCount,
} from './contracts.mjs';

/**
 * @typedef {{ scope_id: string, generation: number, identity_digest: string }} ScopeRef
 * @typedef {{ context_ref: string, scope: ScopeRef, session_ref: string, read: true, export_root_refs: string[], active: boolean }} Binding
 * @typedef {{ kind: string, peer_id?: string }} Caller
 */

/**
 * @param {{ registry: object }} options
 */
export function createAccessRegistry({ registry }) {
  const result = validateAccessRegistry(registry, 'access.registry');
  if (!result.ok) {
    throw new ContractError('invalid access registry', 'INVALID_REQUEST', result.errors);
  }
  const state = deepClone(registry);
  /** @type {Map<string, Binding>} */
  const byContext = new Map();
  /** @type {Map<string, Binding>} */
  const bySession = new Map();
  /** @type {Map<string, {root_ref: string, path: string}>} */
  const exportRoots = new Map();
  for (const binding of state.bindings) byContext.set(binding.context_ref, binding);
  for (const binding of state.bindings) bySession.set(binding.session_ref, binding);
  for (const root of state.export_roots) exportRoots.set(root.root_ref, root);
  const digest = sha256Hex(canonicalJson(state));
  let disposed = false;

  function ensureLive() {
    if (disposed) throw new ContractError('access registry disposed', 'INTERNAL_FAILURE');
  }

  function isOwner(caller) {
    return typeof caller === 'object' && caller !== null && caller.kind === 'owner';
  }

  function checkContext({ caller, contextRef, expectedScopeGeneration }) {
    ensureLive();
    if (!isOwner(caller)) throw new ContractError('owner principal required', 'OWNER_REQUIRED');
    const binding = byContext.get(contextRef);
    if (binding === undefined) throw new ContractError('context is not registered', 'CONTEXT_UNBOUND');
    if (binding.active !== true) throw new ContractError('context binding is inactive', 'SCOPE_REVOKED');
    if (!isSafeCount(expectedScopeGeneration)) throw new ContractError('generation is required', 'INVALID_REQUEST');
    if (binding.scope.generation !== expectedScopeGeneration) {
      throw new ContractError('scope generation does not match the registered binding', 'STALE_SCOPE');
    }
    return binding;
  }

  /**
   * Resolve one export output_ref inside the already-authorized binding.
   * The returned absolute path is server-side only and must never be sent on
   * the wire.
   */
  function checkExport({ caller, contextRef, expectedScopeGeneration, outputRef }) {
    const binding = checkContext({ caller, contextRef, expectedScopeGeneration });
    if (!binding.export_root_refs.includes(outputRef)) {
      throw new ContractError('output_ref is not registered for this binding', 'OUTPUT_REF_DENIED');
    }
    const root = exportRoots.get(outputRef);
    if (root === undefined) throw new ContractError('export root is not registered', 'OUTPUT_REF_DENIED');
    return { binding, rootPath: root.path, rootRef: root.root_ref };
  }

  /** Active readable binding for one live session id, or null. */
  function bindingForSession(sessionRef) {
    ensureLive();
    const binding = bySession.get(sessionRef);
    return binding !== undefined && binding.active === true && binding.read === true ? binding : null;
  }

  /** Owner-visible list; never exposes absolute export paths or session content. */
  function listContexts(caller) {
    ensureLive();
    if (!isOwner(caller)) throw new ContractError('owner principal required', 'OWNER_REQUIRED');
    return state.bindings
      .filter((binding) => binding.active === true && binding.read === true)
      .slice()
      .sort((a, b) => a.context_ref.localeCompare(b.context_ref))
      .map((binding) => ({
        context_ref: binding.context_ref,
        session_ref: binding.session_ref,
        scope_id: binding.scope.scope_id,
        generation: binding.scope.generation,
        read: true,
        export_root_refs: [...binding.export_root_refs],
      }));
  }

  function describe() {
    ensureLive();
    return {
      revision: state.revision,
      digest,
      bindings: state.bindings.length,
      active_bindings: state.bindings.filter((binding) => binding.active === true).length,
      export_roots: exportRoots.size,
    };
  }

  function dispose() {
    disposed = true;
    byContext.clear();
    bySession.clear();
    exportRoots.clear();
  }

  return {
    get revision() { return state.revision; },
    get digest() { return digest; },
    isOwner,
    checkContext,
    checkExport,
    bindingForSession,
    listContexts,
    describe,
    dispose,
  };
}
