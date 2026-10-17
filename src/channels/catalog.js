/**
 * The messaging channels this runtime is being built to serve, as data.
 *
 * This is a DECLARATION, not an integration. Nothing in this file calls Meta, and
 * nothing in this file sends a message. It exists for three reasons:
 *
 *   1. `docs/FACEBOOK_CHANNELS.md` and the code cannot drift apart — the test in
 *      tests/phase75-channels.test.js reads this file and fails if a rule that
 *      decides whether a reply is allowed is changed or dropped.
 *   2. The operator can see, in the admin UI (`GET /v1/admin/channels`), which
 *      channels exist, what each one needs, and what is honestly not built.
 *   3. A future implementer gets the scope, the endpoint, the webhook field and the
 *      time window next to each other instead of in four different places.
 *
 * Every rule below was taken from Meta's own documentation. The rules are the
 * product here: a Messenger reply is only free inside the 24-hour window, a private
 * reply to a comment is one message and only within 7 days, and a WhatsApp service
 * message only exists after the customer writes first. Getting those wrong is not a
 * bug you patch later — it is a policy violation.
 *
 * `status` is deliberately pessimistic. `PLANNED` means exactly that.
 */

/** The credential model every channel shares. */
export const CHANNEL_CREDENTIAL_MODEL = Object.freeze({
  owner: 'client',
  path: 'A',
  decision:
    'Each client owns their own Meta app and completes App Review for it, then keeps their own token and their own customer data on their own site. We never hold a Meta app of our own, so we are never the data controller. Path B (one app we own) was considered and rejected: it would make us the data controller for every client\'s customers, and one app-level problem would become everyone\'s problem at once.',
  note: 'Each client supplies their own Meta app, page/phone id and access token from their own admin panel. The runtime never holds a Meta app of its own, and never holds a customer PII record: a customer is an opaque id to the runtime.',
  blocker: 'per_application_credentials',
  blockerNote: 'An external MCP endpoint currently carries one credential set on the endpoint. Injecting each application\'s own token at call time is not implemented, so a per-shop token today means a per-shop endpoint.'
});

export const CHANNELS = Object.freeze([
  {
    id: 'messenger',
    name: 'Facebook Messenger auto-reply',
    provider: 'meta',
    product: 'messenger-platform',
    direction: 'both',
    webhook: {
      object: 'page',
      fields: ['messages', 'messaging_postbacks'],
      note: 'A customer message arrives as a `messaging` entry. The sender is `sender.id` (a page-scoped id, not a phone number or an email).'
    },
    outbound: [
      { method: 'POST', path: '/{page-id}/messages', body: { recipient: '{sender-id}', messaging_type: 'RESPONSE', message: { text: '…' } } }
    ],
    scopes: ['pages_messaging'],
    window: { kind: '24h', starts: 'the customer\'s last message', note: 'Inside the window a free-form reply is allowed. Outside it, only a message tag Meta has approved for that purpose.' },
    rules: [
      'Reply inside the 24-hour window that the customer opened.',
      'Outside the window, only send a message tag Meta has approved — never a free-form reply.',
      'The agent answers as the shop, not as a general assistant.',
      'Only official Messenger Platform endpoints; no browser automation.'
    ],
    status: 'PLANNED',
    blockedBy: ['per_application_credentials', 'app_review'],
    doc: 'docs/FACEBOOK_CHANNELS.md#2-facebook-messenger'
  },
  {
    id: 'facebook-comments',
    name: 'Facebook comment auto-reply',
    provider: 'meta',
    product: 'graph-api',
    direction: 'both',
    webhook: {
      object: 'page',
      fields: ['feed'],
      note: 'A new comment arrives as a `feed` change with `value.item === "comment"`. A reply to a comment arrives with `value.item === "comments"`. The comment id comes from this webhook — it cannot be guessed.'
    },
    outbound: [
      { method: 'POST', path: '/{comment-id}/comments', body: { message: '…' }, kind: 'public-reply' },
      { method: 'POST', path: '/{page-id}/messages', body: { recipient: { comment_id: '{comment-id}' }, message: { text: '…' } }, kind: 'private-reply' }
    ],
    scopes: ['pages_manage_engagement', 'pages_messaging'],
    window: { kind: '7d', starts: 'the comment', note: 'The private reply is available for 7 days after the comment, and exactly one message may be sent this way.' },
    rules: [
      'The public reply needs `pages_manage_engagement`. The private reply needs `pages_messaging`.',
      'The private reply is ONE message, within 7 days. A second attempt is rejected by Meta.',
      'Only reply to a comment that a `feed` webhook delivered — never to an id from anywhere else.',
      'Never hide, delete or moderate a comment as part of an auto-reply.',
      'Do not answer in a way that could be read as a public commitment the shop cannot keep.'
    ],
    status: 'PLANNED',
    blockedBy: ['per_application_credentials', 'app_review'],
    doc: 'docs/FACEBOOK_CHANNELS.md#3-facebook-comments'
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp auto-reply (Cloud API)',
    provider: 'meta',
    product: 'whatsapp-cloud-api',
    direction: 'both',
    webhook: {
      object: 'whatsapp_business_account',
      fields: ['messages'],
      note: 'Only the official Cloud API. Baileys and whatsmeow are not options: they are an unofficial client of a private protocol, and a shop that depends on one loses its number without warning.'
    },
    outbound: [
      { method: 'POST', path: '/{phone-number-id}/messages', body: { messaging_product: 'whatsapp', to: '{wa-id}', type: 'text', text: { body: '…' } }, kind: 'service-message' },
      { method: 'POST', path: '/{phone-number-id}/messages', body: { messaging_product: 'whatsapp', to: '{wa-id}', type: 'template', template: { name: '…', language: { code: '…' } } }, kind: 'template-message' }
    ],
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    window: { kind: '24h', starts: 'the customer\'s last message', note: 'Inside the window a free-form service message needs no pre-approval and is not charged. Outside it, only a pre-approved template, which is charged.' },
    rules: [
      'The customer writes first. Nothing is sent to a number that has not opted in.',
      'Inside the 24-hour window, a free-form service message needs no pre-approval.',
      'Outside the window, only a pre-approved template message.',
      'Opt-in is mandatory and must be recorded by the shop, not assumed.',
      'This is the shop\'s auto-reply, not a general-purpose AI assistant.'
    ],
    status: 'PLANNED',
    blockedBy: ['per_application_credentials', 'app_review', 'template_approval'],
    doc: 'docs/FACEBOOK_CHANNELS.md#4-whatsapp'
  },
  {
    id: 'facebook-ads',
    name: 'Facebook Ads insights (read-only)',
    provider: 'meta',
    product: 'marketing-api',
    direction: 'outbound',
    webhook: null,
    outbound: [
      { method: 'GET', path: '/{ad-account-id}/insights', query: { fields: 'spend,impressions,clicks,ctr,cpc,actions', date_preset: 'last_7d' } },
      { method: 'GET', path: '/{campaign-id}/insights', query: { fields: 'spend,impressions,clicks,ctr', date_preset: 'last_7d' } }
    ],
    scopes: ['ads_read'],
    window: null,
    rules: [
      'Read-only. `ads_read` is the only scope requested; no write scope is ever asked for.',
      'One token per client, for that client\'s own ad account only.',
      'The operator\'s own ad account is never read on a client\'s behalf.',
      'The agent reports what the numbers say. It does not promise a result.',
      'Pull only — there is no webhook for ad performance.'
    ],
    status: 'PLANNED',
    blockedBy: ['per_application_credentials'],
    doc: 'docs/FACEBOOK_CHANNELS.md#5-facebook-ads'
  }
]);

export function listChannels() {
  return CHANNELS.map(channel => ({ ...channel }));
}

export function getChannel(id) {
  const wanted = String(id ?? '').trim().toLowerCase();
  return CHANNELS.find(channel => channel.id === wanted) ?? null;
}

export function channelSummary() {
  const counts = { total: CHANNELS.length, planned: 0, implemented: 0 };
  for (const channel of CHANNELS) {
    if (channel.status === 'PLANNED') counts.planned += 1;
    else counts.implemented += 1;
  }
  return {
    ...counts,
    credentialModel: CHANNEL_CREDENTIAL_MODEL.owner,
    decision: { path: CHANNEL_CREDENTIAL_MODEL.path, summary: CHANNEL_CREDENTIAL_MODEL.decision },
    blockers: [...new Set(CHANNELS.flatMap(channel => channel.blockedBy))].sort(),
    channels: CHANNELS.map(channel => ({
      id: channel.id,
      name: channel.name,
      product: channel.product,
      status: channel.status,
      window: channel.window?.kind ?? null,
      scopes: [...channel.scopes],
      blockedBy: [...channel.blockedBy]
    }))
  };
}
