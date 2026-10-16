const DEFAULTS = Object.freeze({
  failureThreshold: 3,
  resetTimeoutMs: 15000,
  halfOpenMaxCalls: 1
});

export class OutboundCircuitOpenError extends Error {
  constructor(key, retryAfterMs) {
    super('outbound_circuit_open');
    this.name = 'OutboundCircuitOpenError';
    this.code = 'outbound_circuit_open';
    this.circuitKey = key;
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    this.statusCode = 503;
  }
}

export class OutboundCircuitBreaker {
  constructor({ failureThreshold = DEFAULTS.failureThreshold, resetTimeoutMs = DEFAULTS.resetTimeoutMs, halfOpenMaxCalls = DEFAULTS.halfOpenMaxCalls, logger = null } = {}) {
    this.failureThreshold = Math.max(1, Number(failureThreshold) || DEFAULTS.failureThreshold);
    this.resetTimeoutMs = Math.max(1, Number(resetTimeoutMs) || DEFAULTS.resetTimeoutMs);
    this.halfOpenMaxCalls = Math.max(1, Number(halfOpenMaxCalls) || DEFAULTS.halfOpenMaxCalls);
    this.logger = logger;
    this.states = new Map();
  }

  snapshot(key) {
    const state = this.states.get(key) ?? { state: 'closed', failures: 0, openedAt: 0, halfOpenCalls: 0 };
    return {...state};
  }

  before(key) {
    const now = Date.now();
    const state = this.states.get(key) ?? { state: 'closed', failures: 0, openedAt: 0, halfOpenCalls: 0 };
    if (state.state === 'open') {
      const elapsed = now - state.openedAt;
      if (elapsed < this.resetTimeoutMs) throw new OutboundCircuitOpenError(key, this.resetTimeoutMs - elapsed);
      state.state = 'half-open';
      state.halfOpenCalls = 0;
    }
    if (state.state === 'half-open') {
      if (state.halfOpenCalls >= this.halfOpenMaxCalls) throw new OutboundCircuitOpenError(key, this.resetTimeoutMs);
      state.halfOpenCalls += 1;
    }
    this.states.set(key, state);
    return state.state;
  }

  async success(key, meta = {}) {
    const previous = this.states.get(key);
    this.states.set(key, {state:'closed', failures:0, openedAt:0, halfOpenCalls:0});
    if (previous?.state && previous.state !== 'closed') await this.logger?.info?.('outbound.circuit.closed', {circuitKey:key, previousState:previous.state, ...meta});
  }

  async failure(key, error, meta = {}) {
    const state = this.states.get(key) ?? {state:'closed', failures:0, openedAt:0, halfOpenCalls:0};
    if (!shouldCountCircuitFailure(error)) {
      await this.logger?.info?.('outbound.circuit.failure_ignored', {circuitKey:key, reason: classifyCircuitFailure(error), ...meta});
      if (state.state === 'half-open') state.state = 'closed';
      state.halfOpenCalls = 0;
      this.states.set(key, state.state === 'closed' ? {state:'closed', failures:0, openedAt:0, halfOpenCalls:0} : state);
      return;
    }
    state.failures += 1;
    state.halfOpenCalls = 0;
    if (state.failures >= this.failureThreshold || state.state === 'half-open') {
      state.state = 'open';
      state.openedAt = Date.now();
      await this.logger?.warn?.('outbound.circuit.opened', {circuitKey:key, failures:state.failures, resetTimeoutMs:this.resetTimeoutMs, error:diagnoseOutboundError(error), ...meta});
    }
    this.states.set(key, state);
  }

  reset(key) { this.states.delete(key); }
}

function classifyCircuitFailure(error) {
  const status = Number(error?.statusCode);
  if (status >= 400 && status < 500) return status === 429 ? 'rate_limited' : 'client_error';
  if (status >= 500) return 'server_error';
  return 'transport_error';
}

export function shouldCountCircuitFailure(error) {
  const status = Number(error?.statusCode);
  if (status >= 400 && status < 500) return false;
  return true;
}

export function diagnoseOutboundError(error) {
  const message = String(error?.message ?? error ?? '');
  const status = Number(error?.statusCode);
  if (status >= 400 && status < 500) return {code:'outbound_http_client_error', remediation: status === 429 ? 'respect_retry_after_and_backoff' : 'inspect_request_auth_and_payload'};
  if (status >= 500) return {code:'outbound_http_server_error', remediation:'inspect_remote_status_and_retry_policy'};
  if (/Invalid IP address: undefined/i.test(message)) return {code:'outbound_lookup_all_contract_mismatch', remediation:'use_all_array_callback_shape'};
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return {code:'outbound_dns_failure', remediation:'verify_hostname_and_dns'};
  if (/ETIMEDOUT|provider_timeout|mcp_timeout/i.test(message)) return {code:'outbound_timeout', remediation:'check_remote_health_and_timeout'};
  if (/ECONNREFUSED/i.test(message)) return {code:'outbound_connection_refused', remediation:'verify_remote_service'};
  if (/certificate|CERT_|TLS/i.test(message)) return {code:'outbound_tls_failure', remediation:'verify_certificate_and_hostname'};
  return {code:'outbound_unknown_failure', remediation:'inspect_correlated_log'};
}

export function createCircuitKey(url) {
  const target = new URL(String(url));
  return `${target.protocol}//${target.host}`;
}

export const sharedOutboundCircuitBreaker = new OutboundCircuitBreaker();
export function configureOutboundCircuitLogger(logger) { sharedOutboundCircuitBreaker.logger = logger ?? null; }
export function configureOutboundCircuitBreaker(options = {}) {
  const next = new OutboundCircuitBreaker({...options, logger: sharedOutboundCircuitBreaker.logger});
  sharedOutboundCircuitBreaker.failureThreshold = next.failureThreshold;
  sharedOutboundCircuitBreaker.resetTimeoutMs = next.resetTimeoutMs;
  sharedOutboundCircuitBreaker.halfOpenMaxCalls = next.halfOpenMaxCalls;
  return sharedOutboundCircuitBreaker;
}
export async function protectOutbound(url, operation, meta = {}) {
  const key = createCircuitKey(url);
  sharedOutboundCircuitBreaker.before(key);
  try {
    const result = await operation();
    await sharedOutboundCircuitBreaker.success(key, meta);
    return result;
  } catch (error) {
    await sharedOutboundCircuitBreaker.failure(key, error, meta);
    throw error;
  }
}
