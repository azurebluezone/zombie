import test from 'node:test';
import assert from 'node:assert/strict';
import { send } from '../src/http/json.js';
import { maskCanonicalResponse } from '../src/providers/masking/provider-mask.js';

/*
 * phase74 — the OpenAI wire contract.
 *
 * The success shapes (`chat.completion`, `chat.completion.chunk`, `/v1/models`)
 * were already correct and are proven by live probes. The gap was the error
 * envelope: the runtime answered `{error:'code'}` while an OpenAI client reads
 * `error.message`, so every failure degraded to "Error code: 401" with no reason.
 *
 * These tests pin the envelope so it cannot drift back.
 */

function fakeRes() {
  return {
    headersSent: false,
    statusCode: null,
    headers: null,
    body: null,
    raw: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(payload) { this.raw = payload; this.body = JSON.parse(payload); },
  };
}

function sendAndRead(status, body) {
  const res = fakeRes();
  send(res, status, body);
  return res;
}

test('phase74 a 4xx string error becomes the OpenAI envelope', () => {
  const { body } = sendAndRead(401, { error: 'application_unauthorized_or_expired' });
  assert.deepEqual(body, {
    error: {
      message: 'application_unauthorized_or_expired',
      type: 'invalid_request_error',
      param: null,
      code: 'application_unauthorized_or_expired',
    },
  });
});

test('phase74 a 5xx is server_error and a 429 is rate_limit_error', () => {
  assert.equal(sendAndRead(503, { error: 'tool_execution_not_verified' }).body.error.type, 'server_error');
  assert.equal(sendAndRead(500, { error: 'stream_failed' }).body.error.type, 'server_error');
  assert.equal(sendAndRead(429, { error: 'provider_rate_limited' }).body.error.type, 'rate_limit_error');
});

test('phase74 sibling fields survive the rewrite', () => {
  const { body } = sendAndRead(503, { error: 'tool_execution_not_verified', executionMode: 'chat-only', required: 'tools-enabled' });
  assert.equal(body.error.code, 'tool_execution_not_verified');
  assert.equal(body.executionMode, 'chat-only');
  assert.equal(body.required, 'tools-enabled');
  assert.equal(Object.hasOwn(body, 'error') && typeof body.error, 'object');
});

test('phase74 a string param names the offending field', () => {
  const { body } = sendAndRead(400, { error: 'messages_required', param: 'messages' });
  assert.equal(body.error.param, 'messages');
  assert.equal(body.error.code, 'messages_required');
});

test('phase74 a success body is never rewritten', () => {
  const payload = { id: 'chatcmpl-1', object: 'chat.completion', choices: [] };
  const { body } = sendAndRead(200, payload);
  assert.deepEqual(body, payload);
  assert.equal(typeof body.error, 'undefined');
});

test('phase74 a body that is already an object error is left alone', () => {
  const payload = { error: { message: 'x', type: 'invalid_request_error', param: null, code: 'x' } };
  assert.deepEqual(sendAndRead(400, payload).body, payload);
});

test('phase74 a non-object body is left alone', () => {
  assert.equal(sendAndRead(500, 'boom').body, 'boom');
  assert.equal(sendAndRead(500, null).body, null);
});

test('phase74 maskCanonicalResponse adds logprobs:null and keeps an explicit value', () => {
  const masked = maskCanonicalResponse({
    id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'upstream-model',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
      { index: 1, message: { role: 'assistant', content: 'yo' }, finish_reason: 'stop', logprobs: { content: [] } },
    ],
  }, { agentId: 'code-guru' });

  assert.equal(masked.choices[0].logprobs, null, 'a missing logprobs becomes an explicit null');
  assert.deepEqual(masked.choices[1].logprobs, { content: [] }, 'an explicit logprobs is untouched');
  assert.equal(masked.provider, 'ZombieCoder');
  assert.notEqual(masked.model, 'upstream-model', 'the upstream model name is still masked');
  assert.equal(masked.choices[0].message.content, 'hi');
});
