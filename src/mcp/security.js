import { assertSafeOutboundUrl } from '../network/outbound-policy.js';

export async function assertSafeMcpUrl(value,{allowHosts=[],allowHttp=false,allowPrivateNetwork=false}={}) {
  if (allowHttp && (!allowPrivateNetwork || !allowHosts.length)) {
    throw new Error('mcp_http_requires_private_network_and_host_allowlist');
  }
  const url = new URL(String(value));
  if (url.protocol === 'http:' && !allowHttp) throw new Error('outbound_protocol_forbidden');
  return assertSafeOutboundUrl(value, {
    protocols: allowHttp ? ['https:','http:'] : ['https:'],
    allowHosts,
    allowPrivateNetwork,
    requireStandardHttpsPort: url.protocol === 'https:',
  });
}
export async function assertSafeHttpsUrl(value, options={}) {
  const result = await assertSafeMcpUrl(value, options);
  return result.url;
}
