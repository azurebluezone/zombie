import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, unlink } from 'node:fs/promises';

export function createRuntimeIdentity(config = {}) {
  const port = Number(config.port);
  const runtimeId = String(process.env.RUNTIME_ID || `runtime-${port}`);
  const instanceId = String(process.env.INSTANCE_ID || randomUUID());
  const pid = process.pid;
  const host = String(config.host || '127.0.0.1');
  return Object.freeze({
    runtimeId, instanceId, pid, host, port,
    hostname: os.hostname(),
    platform: process.platform,
    nodeVersion: process.version,
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; } // EPERM = exists, owned by another user
}

async function readLockHolder(lockPath) {
  try { return JSON.parse(await readFile(lockPath, 'utf8')); } catch { return null; }
}

export async function acquireRuntimeLock(dataDir, identity, { logger = null } = {}) {
  await mkdir(dataDir, { recursive: true });
  const safe = identity.runtimeId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const lockPath = path.resolve(dataDir, `runtime-${safe}.lock`);

  // The lock is an O_EXCL file rather than an OS-level flock, so a runtime that
  // crashed (or was killed) leaves it behind and every later start fails until
  // somebody deletes the file by hand. Fail closed only while the recorded process
  // is genuinely alive; a lock whose owner is gone belongs to a dead instance and
  // must not block this one. An unreadable lock also fails closed, because the
  // owner is unknown.
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = await readLockHolder(lockPath);
    if (!holder || processAlive(holder.pid)) {
      const locked = new Error(`runtime_instance_already_locked:${identity.runtimeId}`);
      locked.holderPid = holder?.pid ?? null;
      throw locked;
    }
    await logger?.warn?.('runtime.lock.stale_recovered', { runtimeId: identity.runtimeId, lockPath, previousPid: holder.pid ?? null, previousInstanceId: holder.instanceId ?? null, previousAcquiredAt: holder.acquiredAt ?? null });
    await unlink(lockPath);
    try { handle = await open(lockPath, 'wx'); }
    catch (retryError) {
      if (retryError.code === 'EEXIST') throw new Error(`runtime_instance_already_locked:${identity.runtimeId}`);
      throw retryError;
    }
  }
  await handle.writeFile(JSON.stringify({ ...identity, acquiredAt: new Date().toISOString() }) + '\n');
  return async () => {
    try { await handle.close(); } finally {
      try { await unlink(lockPath); } catch {}
    }
  };
}
