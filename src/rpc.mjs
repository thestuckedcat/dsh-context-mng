/**
 * 07 context-mng: Connection RPC boundary.
 *
 * Maps the plugin's four business endpoints onto the rc.5 Connection RPC
 * handler contract. Two invariants live here:
 *
 *  1. `caller` is injected from the real Host `peer` argument and is never
 *     read from JSON. The browser Peer principal is owner; a request body can
 *     never claim another caller or a grant.
 *  2. Every outcome, including denials and unexpected exceptions, is returned
 *     as a well-formed RpcResult whose value is a fixed BusinessResponse. The
 *     handler never throws, so the Host's default `handler failure: <error>`
 *     HTTP 500 path cannot leak internal errors/paths/details.
 */

import {
  ContractError,
  LIMITS,
  REASON_CODES,
  SCHEMA_VERSION,
  jsonByteLength,
  isNonEmptyString,
  isPlainObject,
  isSafeCount,
  okResponse,
  responseForReason,
  validateContextListInput,
  validateExportInput,
  validateGroupReadInput,
  validateObservationInput,
  validateRpcRequest,
} from './contracts.mjs';

export const RPC_CHANNEL = '/local-context';

export const RPC_ENDPOINTS = Object.freeze([
  'context.list',
  'observation.get',
  'group.read',
  'report.export',
]);

/**
 * Build the request handler registered with
 * `ctx.connection.rpc.handle(RPC_CHANNEL, handler)`.
 *
 * @param {{service: object, limits?: object, logger?: {warn: Function, info: Function}}} deps
 * @returns {(endpoint: string, payload: unknown, signal: AbortSignal|undefined, peer: object) => Promise<{ok: true, value: object}>}
 */
export function createRpcHandler({ service, limits = LIMITS, logger } = {}) {
  if (service === undefined || typeof service !== 'object') {
    throw new TypeError('createRpcHandler requires the context service');
  }

  function warn(code, endpoint) {
    try {
      logger?.warn?.(`context-mng: rpc ${endpoint ?? 'unknown'} failed code=${code}`);
    } catch {
      /* diagnostics must never break the response path */
    }
  }

  return async function handleRpc(endpoint, payload, signal, peer) {
    const operation = { operation_id: 'invalid', view_epoch: 0, scope_generation: 0 };
    try {
      if (signal?.aborted === true) throw new ContractError('request aborted', 'INTERNAL_FAILURE');
      if (jsonByteLength(payload) > limits.maxRequestJsonBytes) {
        throw new ContractError('request exceeds the JSON size limit', 'LIMIT_EXCEEDED');
      }
      const caller = callerFromPeer(peer);

      if (endpoint === 'context.list') {
        const envelope = validateListEnvelope(payload);
        operation.operation_id = envelope.operation_id;
        operation.view_epoch = envelope.view_epoch;
        const inputCheck = validateContextListInput(envelope.input);
        throwIfInvalid(inputCheck);
        const data = service.listContexts({ caller });
        return finalize(okResponse({ operationId: envelope.operation_id, viewEpoch: envelope.view_epoch, scopeGeneration: 0, data }), limits);
      }

      const requestCheck = validateRpcRequest(payload, 'request');
      throwIfInvalid(requestCheck);
      const request = /** @type {any} */ (payload);
      operation.operation_id = request.operation_id;
      operation.view_epoch = request.view_epoch;
      operation.scope_generation = request.expected_scope_generation;

      let data;
      switch (endpoint) {
        case 'observation.get': {
          const inputCheck = validateObservationInput(request.input);
          throwIfInvalid(inputCheck);
          data = await service.getObservation({
            caller,
            contextRef: request.context_ref,
            expectedScopeGeneration: request.expected_scope_generation,
            stage: request.input.stage,
            afterRevision: request.input.after_revision,
          });
          break;
        }
        case 'group.read': {
          const inputCheck = validateGroupReadInput(request.input);
          throwIfInvalid(inputCheck);
          data = await service.getGroupText({
            caller,
            contextRef: request.context_ref,
            expectedScopeGeneration: request.expected_scope_generation,
            observationId: request.input.observation_id,
            groupId: request.input.group_id,
            offset: request.input.offset,
            limit: request.input.limit,
          });
          break;
        }
        case 'report.export': {
          const inputCheck = validateExportInput(request.input);
          throwIfInvalid(inputCheck);
          data = await service.exportReport({
            caller,
            contextRef: request.context_ref,
            expectedScopeGeneration: request.expected_scope_generation,
            observationId: request.input.observation_id,
            outputRef: request.input.output_ref,
            expectedRevision: request.input.expected_revision,
          });
          break;
        }
        default:
          throw new ContractError('unknown endpoint', 'UNKNOWN_ENDPOINT');
      }

      const response = okResponse({
        operationId: operation.operation_id,
        viewEpoch: operation.view_epoch,
        scopeGeneration: operation.scope_generation,
        data,
      });
      return finalize(response, limits);
    } catch (error) {
      const reasonCode = mapErrorReason(error);
      warn(reasonCode, endpoint);
      const response = responseForReason({
        operationId: isNonEmptyString(operation.operation_id) ? operation.operation_id : 'invalid',
        viewEpoch: isSafeCount(operation.view_epoch) ? operation.view_epoch : 0,
        scopeGeneration: isSafeCount(operation.scope_generation) ? operation.scope_generation : 0,
        reasonCode,
      });
      return { ok: true, value: response };
    }
  };
}

/**
 * The caller is derived ONLY from the authenticated peer argument. The browser
 * peer is a shared owner; the access registry remains the per-context gate.
 */
export function callerFromPeer(peer) {
  const principal = isPlainObject(peer) ? peer.principal : undefined;
  if (!isPlainObject(principal) || principal.kind !== 'owner') {
    throw new ContractError('owner principal required', 'OWNER_REQUIRED');
  }
  if (peer.signal?.aborted === true) {
    throw new ContractError('peer is no longer live', 'OWNER_REQUIRED');
  }
  return { kind: 'owner', peer_id: typeof peer.id === 'string' ? peer.id : 'browser' };
}

/** context.list uses the shared envelope without a context_ref. */
export function validateListEnvelope(payload) {
  if (!isPlainObject(payload)) throw new ContractError('request must be an object', 'INVALID_REQUEST');
  const errors = [];
  for (const key of Object.keys(payload)) {
    if (!['schema_version', 'operation_id', 'view_epoch', 'input'].includes(key)) {
      errors.push({ path: `request.${key}`, code: 'UNKNOWN_FIELD', message: `unexpected field ${key}` });
    }
  }
  if (payload.schema_version !== SCHEMA_VERSION) errors.push({ path: 'request.schema_version', code: 'CONST', message: 'schema_version must be 1' });
  if (!isNonEmptyString(payload.operation_id)) errors.push({ path: 'request.operation_id', code: 'TYPE', message: 'operation_id must be 1..128 chars' });
  if (!isSafeCount(payload.view_epoch)) errors.push({ path: 'request.view_epoch', code: 'TYPE', message: 'view_epoch must be a non-negative safe integer' });
  if (!isPlainObject(payload.input)) errors.push({ path: 'request.input', code: 'TYPE', message: 'input must be an object' });
  if (errors.length > 0) throw new ContractError('invalid context.list request', 'INVALID_REQUEST', errors.slice(0, 3));
  return { ...payload, input: payload.input };
}

export function mapErrorReason(error) {
  const candidate = error instanceof ContractError ? error.reasonCode : undefined;
  return REASON_CODES.includes(candidate) ? candidate : 'INTERNAL_FAILURE';
}

function throwIfInvalid(result) {
  if (!result.ok) throw new ContractError('invalid request input', 'INVALID_REQUEST', result.errors.slice(0, 3));
}

function finalize(response, limits) {
  if (jsonByteLength(response) > limits.maxResponseJsonBytes) {
    return {
      ok: true,
      value: responseForReason({
        operationId: response.operation_id,
        viewEpoch: response.view_epoch,
        scopeGeneration: response.scope_generation,
        reasonCode: 'LIMIT_EXCEEDED',
      }),
    };
  }
  return { ok: true, value: response };
}
