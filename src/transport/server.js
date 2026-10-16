import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, unlink, chmod, stat } from 'node:fs/promises';

// A unix socket file outlives the process that created it: when a runtime is killed the
// kernel drops the socket and its /proc/net/unix entry, but the filesystem entry stays
// behind. So "the path is absent from /proc/net/unix" is positive proof that nothing is
// bound to it and the file is only residue. When it cannot be proven (no /proc, table
// unreadable, or the path is listed) the transport fails closed exactly as before, so a
// socket that really belongs to a live runtime is never stolen.
export async function isSocketBound(socketPath){
  let table;
  try{ table=await readFile('/proc/net/unix','utf8'); }catch{ return true; }
  for(const line of table.split('\n')){
    const fields=line.trim().split(/\s+/);
    if(fields.length<8) continue;
    if(fields.slice(7).join(' ')===socketPath) return true;
  }
  return false;
}

export async function startTransportServers({handler,config,logger,runtimeIdentity}){
  const servers={http:null,https:null,uds:null};
  try{
    return await startAllTransports({servers,handler,config,logger,runtimeIdentity});
  }catch(error){
    // A transport that fails after the http listener is already bound would otherwise
    // leave a half-open runtime: the port stays taken by a process that never finishes
    // starting. Close what did start before the error leaves this function.
    await stopTransportServers(servers);
    throw error;
  }
}

async function startAllTransports({servers,handler,config,logger,runtimeIdentity}){
  servers.http=createServer(handler);
  await new Promise((resolve,reject)=>{servers.http.once('error',reject);servers.http.listen(config.port,config.host,resolve)});
  await logger?.info?.('runtime.transport.started',{transport:'http',host:config.host,port:config.port,runtimeId:runtimeIdentity?.runtimeId,instanceId:runtimeIdentity?.instanceId});
  if(config.https.enabled){try{const server=createHttpsServer({key:await readFile(config.https.key),cert:await readFile(config.https.cert)},handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.https.port,config.https.host,resolve)});servers.https=server;await logger?.info?.('runtime.transport.started',{transport:'https',host:config.https.host,port:config.https.port,runtimeId:runtimeIdentity?.runtimeId})}catch(error){await logger?.error?.('runtime.transport.failed',{transport:'https',error:error.message});if(config.https.required)throw error}}
  if(config.uds.enabled){try{
    const socketPath=config.uds.path;
    // Never unlink a socket that belongs to a live runtime; a socket left behind by a
    // crashed runtime is residue and must not block this start forever.
    try{const info=await stat(socketPath);if(info.isSocket()){if(await isSocketBound(socketPath))throw new Error('uds_path_already_exists');await unlink(socketPath);await logger?.warn?.('runtime.uds.stale_socket_removed',{path:socketPath,runtimeId:runtimeIdentity?.runtimeId})}}catch(error){if(error.code!=='ENOENT')throw error}
    const server=createServer(handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)});try{await chmod(socketPath,0o600)}catch{}servers.uds=server;await logger?.info?.('runtime.transport.started',{transport:'uds',path:socketPath,runtimeId:runtimeIdentity?.runtimeId})
  }catch(error){await logger?.error?.('runtime.transport.failed',{transport:'uds',path:config.uds.path,error:error.message});if(config.uds.required)throw error}}
  return servers;
}
export async function stopTransportServers(servers){await Promise.all(Object.values(servers).filter(Boolean).map(server=>new Promise(resolve=>{if(!server.listening)return resolve();server.close(()=>resolve())})))}
