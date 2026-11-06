/**
 * 07 context-mng: browser-to-Host transport over rc.5 Connection exact Fetch
 * routes.
 *
 * CTX-DESIGN-2 assumed `ctx.connection.rpc.handle(...)`. The actual rc.5 bytes
 * cannot serve that seam to a profile plugin: route registration resolves
 * `owner.webServer` against the connection service's own context, which does
 * not inject `webServer`, so every external call throws
 * `cannot get property "webServer" without inject` (verified in an isolated
 * rc.5 host; see docs/compatibility.md §2 and the CTX-RPC-03 change note).
 *
 * The supported rc.5 seam is `connection.fetch.register(route)`:
 *  - the route is an exact `/api/...` path, served only for an authenticated
 *    owner Peer. The shared `/api` fetch handler applies the Host/Origin fence
 *    and authentication, rejects every non-owner principal with 403, and only
 *    then invokes this route's `fetch(request)`. The rc.5 exact-route call
 *    passes the request but NOT the peer object; the route therefore records
 *    the Host-owner gate instead of deriving identity from JSON. The access
 *    registry remains the per-context authority, and this is not user input.
 *  - business responses remain the same fixed BusinessResponse objects, so all
 *    validation/authorization/error semantics of src/rpc.mjs are unchanged.
 */

import { ContractError, jsonByteLength, responseForReason } from './contracts.mjs';

export const API_BASE = '/api/context-mng';

/** One exact Fetch route per business endpoint (validated against the allow-list). */
export const API_ROUTE_PATHS = Object.freeze({
  'context.list': `${API_BASE}/context.list`,
  'observation.get': `${API_BASE}/observation.get`,
  'group.read': `${API_BASE}/group.read`,
  'report.export': `${API_BASE}/report.export`,
});

const INVALID_FALLBACK = Object.freeze({ operationId: 'invalid', viewEpoch: 0, scopeGeneration: 0, reasonCode: 'INVALID_REQUEST' });

/**
 * Register the four exact Fetch routes on the rc.5 connection service.
 *
 * @param {{
 *   connection: {fetch: {register: Function}},
 *   rpcHandler: (endpoint: string, payload: unknown, signal: AbortSignal|undefined, peer: object) => Promise<{ok: true, value: object}>,
 *   logger?: {warn: Function},
 * }} deps
 * @returns {() => void} disposer
 */
export function createContextFetchTransport({ connection, rpcHandler, logger }) {
  const disposers = [];
  for (const [endpoint, path] of Object.entries(API_ROUTE_PATHS)) {
    const route = {
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request, peer) => {
        const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
        if (contentType !== 'application/json') {
          return businessResponse(responseForReason(INVALID_FALLBACK));
        }
        let payload;
        try {
          payload = await request.json();
        } catch {
          return businessResponse(responseForReason(INVALID_FALLBACK));
        }
        try {
          // rc.5 exact Fetch routes receive no peer object. The Host shared
          // handler has already enforced the owner gate (403 for every other
          // principal) before invoking this route; record that Host verdict as
          // the caller, never JSON. When a Host version does pass a peer, use
          // it so the extra check in rpc.mjs stays in force.
          const effectivePeer = peer ?? {
            principal: { kind: 'owner' },
            id: 'host-owner-gate',
            signal: request.signal,
          };
          const result = await rpcHandler(endpoint, payload, request.signal, effectivePeer);
          return businessResponse(result.value);
        } catch {
          // rpcHandler is contractually non-throwing; this is a last-resort
          // container so the HTTP route still answers with a fixed response.
          try {
            logger?.warn?.(`context-mng: fetch route ${endpoint} unexpected failure`);
          } catch {
            /* diagnostics must never break the response */
          }
          return businessResponse(responseForReason({ ...INVALID_FALLBACK, reasonCode: 'INTERNAL_FAILURE' }));
        }
      },
    };
    try {
      const dispose = connection.fetch.register(route);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      try {
        logger?.warn?.(`context-mng: fetch route ${endpoint} unavailable: ${error instanceof Error ? error.name : 'unknown'}`);
      } catch {
        /* ignore */
      }
    }
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try {
        dispose?.();
      } catch {
        /* disposal must not throw across the plugin boundary */
      }
    }
  };
}

function businessResponse(value) {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } });
}

/**
 * Content-Type + size guard used by tests and available to future transports.
 * The JSON size bound is enforced by the RPC handler as well.
 */
export function assertJsonPayloadSize(payload, limits) {
  if (jsonByteLength(payload) > limits.maxRequestJsonBytes) {
    throw new ContractError('request exceeds the JSON size limit', 'LIMIT_EXCEEDED');
  }
}
