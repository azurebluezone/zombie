import dns from 'node:dns/promises';
import net from 'node:net';

function privateIpv4(ip) {
  const p=String(ip).split('.').map(Number);
  if(p.length!==4 || p.some(Number.isNaN)) return false;
  return p[0]===0 || p[0]===10 || p[0]===127 || (p[0]===169&&p[1]===254) || (p[0]===172&&p[1]>=16&&p[1]<=31) || (p[0]===192&&p[1]===168);
}
function privateIpv6(ip) {
  const x=String(ip).toLowerCase();
  return x==='::' || x==='::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:');
}
export function isPrivateAddress(address) {
  return net.isIP(address)===4 ? privateIpv4(address) : net.isIP(address)===6 ? privateIpv6(address) : false;
}

function privateHostAllowed(host, allowPrivateNetwork, allowPrivateHosts) {
  const list = allowPrivateHosts.map(String).map(x => x.toLowerCase());
  return allowPrivateNetwork === true && (!list.length || list.includes(host));
}

export async function resolveOutboundHost(hostname,{allowPrivateNetwork=false,allowPrivateHosts=[]}={}) {
  const host=String(hostname).toLowerCase();
  const privateAllowed = privateHostAllowed(host, allowPrivateNetwork, allowPrivateHosts);
  if(net.isIP(host)) {
    if(isPrivateAddress(host) && !privateAllowed) throw new Error('outbound_private_address_forbidden');
    return [{address:host,family:net.isIP(host)}];
  }
  if(host==='localhost' && !privateAllowed) throw new Error('outbound_private_address_forbidden');
  const answers=await dns.lookup(host,{all:true,verbatim:true});
  if(!answers.length) throw new Error('outbound_dns_no_address');
  if(answers.some(a=>isPrivateAddress(a.address)) && !privateAllowed) throw new Error('outbound_dns_private_address_forbidden');
  return answers;
}

export async function assertSafeOutboundUrl(value,{protocols=['https:'],allowPlaintextHttp=false,allowHosts=[],allowPrivateNetwork=false,allowPrivateHosts=[],requireStandardHttpsPort=false}={}) {
  const u=new URL(String(value));
  const allowed=[...protocols];
  if(allowPlaintextHttp && !allowed.includes('http:')) allowed.push('http:');
  if(!allowed.includes(u.protocol)) throw new Error('outbound_protocol_forbidden');
  if(u.username||u.password) throw new Error('outbound_url_credentials_forbidden');
  if(requireStandardHttpsPort && u.protocol==='https:' && u.port && u.port!=='443') throw new Error('outbound_nonstandard_https_port_forbidden');
  const host=u.hostname.toLowerCase();
  const normalizedAllowHosts=allowHosts.map(String).map(x=>x.toLowerCase());
  if(normalizedAllowHosts.length && !normalizedAllowHosts.includes(host)) throw new Error('outbound_host_not_allowlisted');
  const privateHostList = allowPrivateHosts.length ? allowPrivateHosts : allowHosts;
  const answers=await resolveOutboundHost(host,{allowPrivateNetwork,allowPrivateHosts:privateHostList});
  return {url:u,host,answers,lookup:(hostname,options,callback)=>{
    const familyHint=options?.family ?? 0;
    const list=answers.filter(x=>familyHint===0 || x.family===familyHint);
    if (!list.length) list.push(...answers);
    if (options?.all) return callback(null,list);
    return callback(null,list[0].address,list[0].family);
  }};
}
