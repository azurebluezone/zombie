import { readFile } from 'node:fs/promises';
import { assertSafeOutboundUrl } from '../network/outbound-policy.js';

/**
 * Resolve the TLS trust material for one outbound MCP endpoint.
 *
 * An internal MCP server very often presents a certificate signed by an internal
 * CA — or a self-signed one. Node verifies certificates by default, so the
 * connection dies with `DEPTH_ZERO_SELF_SIGNED_CERT` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
 * before any MCP handshake can happen, and the endpoint looks "broken" when the
 * only thing missing is the CA.
 *
 * Precedence, highest first:
 *   1. per-endpoint `ca` (inline PEM) or `caFile` (path to a PEM bundle),
 *   2. the global `MCP_TLS_CA_FILE`,
 *   3. Node's own trust store.
 *
 * `rejectUnauthorized:false` is supported because some lab servers cannot be
 * given a CA at all, but it is never the default: an operator must ask for it,
 * per endpoint or through `MCP_TLS_INSECURE=true`, and the resolved result is
 * returned with `insecure:true` so the caller can log the decision.
 */
export async function resolveTlsOptions({ ca = null, caFile = null, rejectUnauthorized = null } = {}, { env = process.env } = {}) {
  const globalCaFile = env.MCP_TLS_CA_FILE ? String(env.MCP_TLS_CA_FILE).trim() : null;
  const globalInsecure = String(env.MCP_TLS_INSECURE ?? '').trim().toLowerCase() === 'true';

  const file = caFile ? String(caFile).trim() : globalCaFile;
  let caValue = ca ? String(ca) : null;
  if (!caValue && file) {
    try { caValue = await readFile(file, 'utf8'); }
    catch (error) { throw new Error(`mcp_tls_ca_unreadable:${error?.code ?? 'unknown'}`); }
  }

  const reject = (rejectUnauthorized === null || rejectUnauthorized === undefined)
    ? !globalInsecure
    : rejectUnauthorized !== false;

  return { ca: caValue ?? undefined, rejectUnauthorized: reject, insecure: reject === false, caFile: file ?? null };
}

export async function assertSafeMcpUrl(value, { allowHosts = [], allowHttp = false, allowPrivateNetwork = false, tls = null, env = process.env } = {}) {
  if (allowHttp && (!allowPrivateNetwork || !allowHosts.length)) {
    throw new Error('mcp_http_requires_private_network_and_host_allowlist');
  }
  const url = new URL(String(value));
  if (url.protocol === 'http:' && !allowHttp) throw new Error('outbound_protocol_forbidden');
  const safe = await assertSafeOutboundUrl(value, {
    protocols: allowHttp ? ['https:', 'http:'] : ['https:'],
    allowHosts,
    allowPrivateNetwork,
    // The blanket "standard HTTPS port only" default protects a caller that never
    // named a host. Once an operator has explicitly allowlisted the host, that
    // naming *is* the trust decision, so an internal server on
    // `https://host:8443` becomes reachable instead of failing as a policy error.
    // With no allowlist the stricter default is unchanged.
    requireStandardHttpsPort: url.protocol === 'https:' && allowHosts.length === 0,
  });
  return { ...safe, tls: await resolveTlsOptions(tls ?? {}, { env }) };
}
export async function assertSafeHttpsUrl(value, options = {}) {
  const result = await assertSafeMcpUrl(value, options);
  return result.url;
}
