import test from 'node:test';
import assert from 'node:assert/strict';
import { AppLimits } from '../src/mcp/limits.js';
import { validateToolArguments } from '../src/mcp/schema.js';

test('tool schema rejects missing required argument', () => {
  assert.throws(() => validateToolArguments({inputSchema:{type:'object',required:['q'],properties:{q:{type:'string'}}}}, {}), /mcp_tool_argument_required:q/);
});
test('application concurrency limit releases after completion', () => {
  const limits=new AppLimits({maxRequests:10,maxConcurrent:1});
  const release=limits.acquire('app');
  assert.throws(()=>limits.acquire('app'), /application_concurrency_limited/);
  release();
  assert.doesNotThrow(()=>{ const r=limits.acquire('app'); r(); });
});
