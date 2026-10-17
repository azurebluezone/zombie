import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, CHANNEL_CREDENTIAL_MODEL, getChannel, listChannels, channelSummary } from '../src/channels/catalog.js';
import { ECOMMERCE_AGENT_TOOL_BOUNDARIES } from '../src/agents/ecommerce-tool-boundaries.js';
import { ToolRegistry } from '../src/tools/registry.js';

/*
 * phase75 — the messaging-channel declaration.
 *
 * Nothing here is an integration, so there is no behaviour to test. What CAN be
 * tested is that the rules that decide whether a reply is allowed are recorded
 * correctly, and that the declaration has not drifted away from the rest of the
 * code. A wrong window here is a policy violation later, so it is pinned.
 */

const byId = (id) => CHANNELS.find((channel) => channel.id === id);

function stubStore(initial = []) {
  const data = new Map([['tools', structuredClone(initial)]]);
  return {
    async read(collection, fallback = []) { return data.has(collection) ? structuredClone(data.get(collection)) : fallback; },
    async write(collection, value) { data.set(collection, structuredClone(value)); },
  };
}

test('phase75 every channel is declared once, with the four we need', () => {
  const ids = CHANNELS.map((channel) => channel.id);
  assert.deepEqual([...ids].sort(), ['facebook-ads', 'facebook-comments', 'messenger', 'whatsapp']);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate channel id');
  for (const channel of CHANNELS) {
    assert.equal(channel.provider, 'meta');
    assert.equal(channel.status, 'PLANNED', `${channel.id} must not claim to be built`);
    assert.ok(channel.scopes.length, `${channel.id} must name the scopes it needs`);
    assert.ok(channel.rules.length >= 3, `${channel.id} must carry its rules, not just a name`);
    assert.ok(channel.doc.includes('FACEBOOK_CHANNELS.md'), `${channel.id} must point at the plan`);
  }
});

test('phase75 the Meta windows and limits are recorded as Meta documents them', () => {
  // Messenger: free-form only inside the 24 hours the customer opened.
  assert.equal(byId('messenger').window.kind, '24h');
  assert.ok(byId('messenger').scopes.includes('pages_messaging'));

  // Comments: the private reply is ONE message and only within 7 days.
  const comments = byId('facebook-comments');
  assert.equal(comments.window.kind, '7d');
  assert.ok(comments.scopes.includes('pages_manage_engagement'), 'the public reply needs the engagement scope');
  assert.ok(comments.scopes.includes('pages_messaging'), 'the private reply needs the messaging scope');
  assert.ok(comments.rules.some((rule) => /ONE message/.test(rule)), 'the one-message limit must be stated');
  assert.ok(comments.rules.some((rule) => /feed/.test(rule)), 'the comment id must come from the feed webhook');

  // WhatsApp: the customer writes first; outside the window only a template.
  const whatsapp = byId('whatsapp');
  assert.equal(whatsapp.window.kind, '24h');
  assert.equal(whatsapp.webhook.object, 'whatsapp_business_account');
  assert.ok(whatsapp.rules.some((rule) => /opt in|opt-in/i.test(rule)));
  assert.ok(whatsapp.rules.some((rule) => /template/i.test(rule)));
  assert.ok(!JSON.stringify(whatsapp).includes('baileys'), 'the unofficial client is not an option');
});

test('phase75 Facebook Ads is read-only and never touches the operator account', () => {
  const ads = byId('facebook-ads');
  assert.deepEqual(ads.scopes, ['ads_read'], 'no write scope is ever requested');
  assert.equal(ads.webhook, null, 'ad performance is pull-only');
  assert.ok(ads.rules.some((rule) => /operator/i.test(rule)), 'the operator account rule must be stated');
  assert.ok(ads.rules.some((rule) => /read-only/i.test(rule)));
  assert.equal(ads.direction, 'outbound');
});

test('phase75 the credential model is client-owned and says what blocks it', () => {
  assert.equal(CHANNEL_CREDENTIAL_MODEL.owner, 'client');
  assert.equal(CHANNEL_CREDENTIAL_MODEL.blocker, 'per_application_credentials');
  assert.ok(CHANNEL_CREDENTIAL_MODEL.note.includes('never holds a Meta app of its own'));
  for (const channel of CHANNELS) {
    assert.ok(channel.blockedBy.includes('per_application_credentials'), `${channel.id} is blocked on per-application credentials`);
  }
});

test('phase75 Path A stands: the client owns the app, not us', () => {
  // The operator's decision. It is pinned because the opposite choice — one app we
  // own — would make us the data controller for every client's customers, and that
  // is a different business, not a cheaper deployment.
  assert.equal(CHANNEL_CREDENTIAL_MODEL.path, 'A');
  assert.ok(CHANNEL_CREDENTIAL_MODEL.decision.includes('Each client owns their own Meta app'));
  assert.ok(CHANNEL_CREDENTIAL_MODEL.decision.includes('never the data controller'));
  assert.ok(CHANNEL_CREDENTIAL_MODEL.decision.includes('rejected'), 'Path B is recorded as rejected, not as a quiet fallback');
  assert.equal(channelSummary().decision.path, 'A');
});

test('phase75 getChannel / listChannels / channelSummary behave', () => {
  assert.equal(getChannel('MESSENGER').id, 'messenger');
  assert.equal(getChannel('nope'), null);
  assert.equal(getChannel(null), null);
  assert.notEqual(listChannels(), CHANNELS, 'the caller gets a copy');
  const summary = channelSummary();
  assert.equal(summary.total, 4);
  assert.equal(summary.planned, 4);
  assert.equal(summary.implemented, 0);
  assert.equal(summary.credentialModel, 'client');
  assert.ok(summary.blockers.includes('app_review'));
  assert.equal(summary.channels.length, 4);
  assert.equal(summary.channels[0].scopes.length > 0, true);
});

test('phase75 a boundary channel id must exist in the catalog', () => {
  const known = new Set(CHANNELS.map((channel) => channel.id));
  for (const [agentId, boundary] of Object.entries(ECOMMERCE_AGENT_TOOL_BOUNDARIES)) {
    assert.ok(Array.isArray(boundary.channels), `${agentId} must declare channels`);
    for (const channelId of boundary.channels) {
      assert.ok(known.has(channelId), `${agentId} names an unknown channel: ${channelId}`);
    }
  }
});

test('phase75 a boundary toolIds entry must be a runnable runtime tool', async () => {
  const runnable = new Set((await new ToolRegistry(stubStore()).list()).map((tool) => tool.id));
  for (const [agentId, boundary] of Object.entries(ECOMMERCE_AGENT_TOOL_BOUNDARIES)) {
    for (const toolId of boundary.toolIds) {
      assert.ok(runnable.has(toolId), `${agentId} names a tool that is not a runtime tool: ${toolId}`);
    }
  }
});
