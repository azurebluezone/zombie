/*
 * The token vault.
 *
 * A user's token is the one thing in this runtime that a customer is given and
 * that must keep working. Until now it was stored as a SHA-256 hash and shown
 * exactly once: if it was lost, the only way to get it back was to rotate it, and
 * the operator had no way to answer "what is that client's token?" without
 * invalidating the one the client was already using.
 *
 * The operator asked to be able to read it back. That is a real convenience and a
 * real trade-off, so it is implemented honestly rather than by writing the token
 * into the file:
 *
 *   - the hash stays. Authentication uses `apiKeyHash` and a constant-time
 *     compare, exactly as before. Nothing is decrypted on a request path, so a
 *     vault that is misconfigured or slow can never slow down or break logins.
 *   - the token is *also* stored sealed with AES-256-GCM under a key that lives in
 *     the environment, never in the store. A stolen data file, a backup, a synced
 *     folder or a support bundle therefore contains no usable token — the thief
 *     gets ciphertext and a key id.
 *   - every unseal is an audited event. Reading a customer token is a privileged
 *     action and it leaves a row. "Never hide errors" applies to privileged reads
 *     too.
 *   - no key configured means no sealed copy, and the API says so with
 *     `token_not_recoverable` instead of pretending. Rotate to get a new one.
 *
 * The key id is a hash of the key, not the key. It is stored in each envelope so
 * that after a key rotation the failure is specific — "this was sealed under a
 * different key" — rather than a generic authentication failure that reads like
 * corruption.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_VAULT_VERSION = 1;
export const TOKEN_VAULT_ALGORITHM = 'aes-256-gcm';

/**
 * Refuse a key short enough to be guessed. The key is not a user password — it is
 * a machine secret that the operator generates once — so anything under 24
 * characters is a mistake, and a mistake here silently weakens every stored token.
 */
export const TOKEN_VAULT_MIN_SECRET_CHARS = 24;

function deriveKey(secret) {
  // 32 bytes for AES-256, from any key length the operator supplies. A
  // high-entropy input stays high-entropy under SHA-256; a low-entropy one is
  // rejected by the length check instead of being silently stretched into
  // something that looks strong.
  return createHash('sha256').update(secret, 'utf8').digest();
}

function keyIdOf(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * @param {string} rawSecret the value of TOKEN_ENCRYPTION_KEY
 * @returns {null | {keyId:string, seal:Function, open:Function, canOpen:Function}} null when no key is configured
 */
export function createTokenVault(rawSecret) {
  const secret = String(rawSecret ?? '').trim();
  if (!secret) return null;
  if (secret.length < TOKEN_VAULT_MIN_SECRET_CHARS) {
    throw new Error(`token_vault_secret_too_short:${secret.length}<${TOKEN_VAULT_MIN_SECRET_CHARS}`);
  }

  const key = deriveKey(secret);
  const keyId = keyIdOf(key);

  const seal = (token) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv(TOKEN_VAULT_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
    return {
      v: TOKEN_VAULT_VERSION,
      alg: TOKEN_VAULT_ALGORITHM,
      kid: keyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ciphertext.toString('base64')
    };
  };

  const open = (envelope) => {
    if (!envelope || typeof envelope !== 'object') throw new Error('token_not_recoverable');
    if (envelope.v !== TOKEN_VAULT_VERSION || envelope.alg !== TOKEN_VAULT_ALGORITHM) {
      throw new Error(`token_vault_envelope_unsupported:${String(envelope.alg ?? 'unknown')}`);
    }
    if (envelope.kid !== keyId) throw new Error('token_vault_key_changed');
    let decipher;
    try {
      decipher = createDecipheriv(TOKEN_VAULT_ALGORITHM, key, Buffer.from(String(envelope.iv), 'base64'));
      decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(String(envelope.ct), 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // GCM authentication failed: the ciphertext or the tag was altered. Say that,
      // rather than handing back a mangled token that fails at the client instead.
      throw new Error('token_vault_authentication_failed');
    }
  };

  const canOpen = (envelope) => {
    if (!envelope || typeof envelope !== 'object') return false;
    return envelope.v === TOKEN_VAULT_VERSION
      && envelope.alg === TOKEN_VAULT_ALGORITHM
      && typeof envelope.kid === 'string'
      && typeof envelope.kid === 'string'
      && envelope.kid.length === keyId.length
      && timingSafeEqual(Buffer.from(envelope.kid), Buffer.from(keyId));
  };

  return { keyId, seal, open, canOpen };
}

/** A fresh key for the operator to paste into the environment. */
export function generateVaultSecret() {
  return randomBytes(32).toString('base64url');
}
