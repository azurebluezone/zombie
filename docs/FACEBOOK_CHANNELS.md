# Facebook, Messenger and WhatsApp — the channel plan

This document is the plan for the messaging channels the runtime is being built
to serve, written so that the next person to touch this can start and finish
without guessing. It is a plan, not a description of working code: read
[§8](#8-what-is-implemented-and-what-is-not) before assuming anything runs.

Everything here comes from Meta's own documentation. The rules are the product.
A Messenger reply outside the 24-hour window, a second private reply to a
comment, or a WhatsApp message to a number that never opted in is not a bug to
patch later — it is a policy violation, and Meta's response to it is a restricted
app.

The machine-readable form of this plan lives in `src/channels/catalog.js`, and
`tests/phase75-channels.test.js` fails if the two drift apart.

---

## 1. Scope, and the one decision that is still open

### 1.1 What we serve

| Channel | Direction | What it does |
| --- | --- | --- |
| Facebook Messenger | both | auto-reply to a customer message in the Page inbox |
| Facebook comments | both | public reply to a comment, and one private reply to the commenter |
| WhatsApp (Cloud API) | both | auto-reply to a customer message, as the shop |
| Facebook Ads insights | outbound | read-only campaign performance for the shop |

### 1.2 What we do not do

The runtime holds **no Meta app of its own**, **no client token**, and **no
customer record**. A customer is an opaque id to the runtime. The shop's Laravel
application is the system of record; it holds the phone number, the address and
the order history, and it is the only place a support PIN maps to a person.

That is a deliberate limit, not an unfinished feature. If the runtime held the
token, a bug in the runtime would be a security incident for every client at
once.

### 1.3 The open decision: Path A or Path B

| | Path A — each client owns their Meta app | Path B — we own one app |
| --- | --- | --- |
| Who creates the Meta app | the client | us |
| Who passes App Review | the client, once, for their own app | us, once, for everyone |
| Who holds the token | the client | the client (a token for our app, scoped to their assets) |
| Who is the data controller | the client | us |
| Work per new client | higher: they walk through App Review | lower: they paste a token |
| Blast radius of an app-level problem | one client | every client |
| Matches "clients bring their own token" | yes | partly |

**Not chosen yet.** Path A is what the business model describes — clients bring
their own Meta tokens and apps — and it keeps us out of the data-controller
role. Path B is less work per client and makes onboarding a copy-paste, at the
cost of owning the Meta relationship for everyone.

Nothing in this document depends on the answer. Everything below works with
either, because in both paths the token belongs to the client and arrives
per-application. The answer only changes who completes App Review.

### 1.4 Transport

The Graph API and the Messenger Platform are **REST over HTTPS with JSON bodies
and webhook callbacks**. They are not gRPC. (`external-mcp/servers.json` declares
a `facebook-ads` endpoint as `grpc`; that points at an internal service of the
client's, not at the Graph API, and it stays refused with
`mcp_transport_grpc_requires_bridge` until a JSON/HTTP facade exists in front of
it. Do not send the Graph API down that path.)

---

## 2. Facebook Messenger

### 2.1 Webhook

- **Object:** `page`. **Fields:** `messages`, `messaging_postbacks`.
- **Subscription handshake:** Meta calls `GET` on the callback with
  `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`. Compare
  `hub.verify_token` with the shop's configured verify token and echo
  `hub.challenge` back as plain text.
- **Delivery:** `POST` with a JSON body and an `X-Hub-Signature-256` header.
- **Verify before parsing.** The signature is `sha256=` + HMAC-SHA256 of the
  **raw request body** (the bytes, not the re-serialised JSON) keyed with the
  app secret. Compare with a constant-time comparison
  (`crypto.timingSafeEqual`). A body that fails the check is discarded without
  being parsed.
- **Idempotency:** a webhook is delivered *at least once*. `message.mid` is the
  dedupe key. A repeated `mid` must not produce a second reply. This is not
  optional: a duplicate reply to a customer is the most visible failure this
  feature can have.

### 2.2 Inbound shape

```json
{
  "object": "page",
  "entry": [
    {
      "id": "<page-id>",
      "time": 1730000000000,
      "messaging": [
        {
          "sender": { "id": "<page-scoped-sender-id>" },
          "recipient": { "id": "<page-id>" },
          "timestamp": 1730000000000,
          "message": { "mid": "m_...", "text": "দাম কত?" }
        }
      ]
    }
  ]
}
```

`recipient.id` is the page id, and it is how the runtime decides **which shop**
the message belongs to.

### 2.3 Reply

```
POST /{page-id}/messages
{
  "recipient": { "id": "<page-scoped-sender-id>" },
  "messaging_type": "RESPONSE",
  "message": { "text": "…" }
}
```

Scope: `pages_messaging`.

### 2.4 The window

The customer's message opens a **24-hour window**. Inside it a free-form reply is
allowed. Outside it, only a message tag Meta has approved for that purpose —
never a free-form reply. The runtime must check the window before it calls the
API, not after the API rejects the call.

### 2.5 What the agent is

The agent answers **as the shop**. It is not a general-purpose assistant and must
not behave like one. It has the shop's product and order facts available through
the shop's own tools (`get_product`, `check_stock`, `get_order_status`,
`apply_coupon`) and it says "I do not know" rather than inventing an answer.

---

## 3. Facebook comments

### 3.1 Webhook

- **Object:** `page`. **Field:** `feed`.
- `value.item === "comment"` — a new comment on one of the page's posts.
- `value.item === "comments"` — someone replied to an existing comment.
- `value.comment_id` is the id to reply to. `value.post_id` is the post.
  `value.from.id` is the commenter.

**The comment id must come from this webhook.** It cannot be derived, guessed or
looked up reliably, and an id from anywhere else is a bug waiting to happen.

Same signature verification and same dedupe discipline as §2.1, keyed on
`comment_id` plus the reply kind.

### 3.2 Public reply

```
POST /{comment-id}/comments
{ "message": "…" }
```

Scope: `pages_manage_engagement`. This is visible under the post.

### 3.3 Private reply

```
POST /{page-id}/messages
{
  "recipient": { "comment_id": "<comment-id>" },
  "message": { "text": "…" }
}
```

Scope: `pages_messaging`. Two hard limits:

1. **One message only.** A second attempt is rejected by Meta.
2. **Within 7 days** of the comment.

### 3.4 What we never do

- Never hide, delete or otherwise moderate a comment as part of an auto-reply.
- Never make a public commitment on the shop's behalf that the shop cannot keep
  (a delivery date, a refund, a discount). The public reply answers the question
  and, where the answer needs account detail, moves the conversation to the
  private reply.

---

## 4. WhatsApp

### 4.1 Only the official Cloud API

The **WhatsApp Cloud API** is the only option. `Baileys` and `whatsmeow` are
unofficial clients of a private protocol: a shop that depends on one loses its
number without warning and with no appeal. This is not a preference, it is a
constraint.

### 4.2 Webhook

- **Object:** `whatsapp_business_account`. **Field:** `messages`.
- Inbound path: `entry[].changes[].value.messages[]` →
  `{ from, id, timestamp, text: { body } }`, with the display name under
  `value.contacts[]`.
- Same signature verification (`X-Hub-Signature-256`, app secret, raw body) and
  the same dedupe discipline, keyed on the message `id`.

### 4.3 The window and the two message kinds

| | Inside the 24-hour window | Outside the window |
| --- | --- | --- |
| What may be sent | a free-form **service message** | a pre-approved **template message** |
| Pre-approval | not needed | required, and per template |
| Cost | not charged | charged per conversation |
| Who opens the window | the customer's last message | — |

### 4.4 Opt-in

The customer writes first. Nothing is sent to a number that has not opted in, and
the opt-in is recorded by the shop, not assumed by the runtime. A shop that
messages numbers which never wrote to it is the fastest way to lose the number.

### 4.5 What the agent is

"Your shop's auto-reply", not a general AI assistant. Same rule as §2.5.

---

## 5. Facebook Ads

### 5.1 Pull only

There is no webhook for ad performance. The runtime asks:

```
GET /{ad-account-id}/insights?fields=spend,impressions,clicks,ctr,cpc,actions&date_preset=last_7d
GET /{campaign-id}/insights?fields=spend,impressions,clicks,ctr&date_preset=last_7d
```

### 5.2 Scope

`ads_read` only. **No write scope is ever requested.** Reading performance is the
whole feature; creating or editing a campaign is not, and asking for a write
scope would make every client's App Review harder for no benefit.

### 5.3 Rules

- One token per client, for that client's own ad account.
- The operator's own ad account is never read on a client's behalf.
- The agent reports what the numbers say. It does not promise a result.

### 5.4 Where it fits

Two honest options, and the second is better once §7 exists:

1. **An external MCP server** that wraps the Marketing API and is declared as an
   `http` endpoint. No runtime code; the discovered tools reach the agent's
   surface on their own.
2. **A native tool** reading the per-application token from §7, in the same shape
   as `fetch_web_page`. Fewer moving parts, and the token never leaves the
   process.

Either way the token is per-application. That is §7.

---

## 6. Where each piece lives

| Piece | Path | Status |
| --- | --- | --- |
| Channel declaration (this plan, as data) | `src/channels/catalog.js` | **built** |
| Operator view of the plan | `GET /v1/admin/channels` | **built** |
| Agent → channel mapping | `src/agents/ecommerce-tool-boundaries.js` (`channels`) | **built** |
| Webhook receiver | `src/channels/webhook.js` | not built |
| Signature verification + dedupe | `src/channels/webhook.js` | not built |
| Per-application credentials | `src/registry/` + `src/execution/` | not built — the blocker |
| Outbound Graph client | `src/channels/graph.js` | not built |
| Reply orchestration (webhook → agent → reply) | `src/channels/` | not built |
| Local model with cloud overflow | provider layer | not built |

The outbound path must reuse `src/network/outbound-policy.js`
(`assertSafeOutboundUrl`, the pinned DNS `lookup`) and the circuit breaker in
`src/network/circuit-breaker.js`. The outbound path for `fetch_web_page` is the
reference implementation: `tools/common/web_tools.js`.

---

## 7. The token model — the one real blocker

Every channel above needs one thing the runtime does not have: **a credential
that belongs to one application.**

### 7.1 What exists

`src/mcp/registry.js` `normalizeAuthHeaders()` binds `headers.authorization =
Bearer <token>` to the **endpoint**, set once at registration. There is no way to
say "use this application's token for this call".

### 7.2 Why that blocks the business model

The model is "the client brings their own Meta token". With endpoint-bound
credentials, one token means one endpoint, so a per-shop token means a per-shop
endpoint — which is one process per shop, which is exactly the thing the
architecture is trying not to do.

### 7.3 What to build

1. A per-application credential store: `applicationId` → the client's Meta
   material (`pageId`, `appSecret`, `accessToken`, and the WhatsApp phone number
   id where relevant).
2. Never returned by any `GET`. Write-only through the admin API, like an
   application key: store a hash or an encrypted value, never the plaintext.
3. Resolved at **call time**, not at registration:
   `src/execution/mcp-adapter.js` `execute({applicationId})` already receives the
   application id and already resolves the per-application permission — that is
   the place to resolve the per-application headers too.
4. The same store feeds the native outbound Graph client from §5.4 option 2.

Precedence, so an existing deployment keeps working: per-application credential
→ endpoint credential → refused.

### 7.4 The App Review dependency

`pages_messaging`, `pages_manage_engagement` and `whatsapp_business_messaging`
are not granted by default. Until App Review passes, the channel works only for
accounts with a role on the app. That is a Meta-side dependency with a
Meta-side timeline; it cannot be scheduled from here. Treat the outcome as
`UNVERIFIED` until it is granted.

---

## 8. What is implemented and what is not

| Claim | Status | Basis |
| --- | --- | --- |
| The channel plan is recorded as data and pinned by a test | **SOURCE_VERIFIED** | `src/channels/catalog.js`; `tests/phase75-channels.test.js` (7 tests) |
| `GET /v1/admin/channels` reports the plan | **SOURCE_VERIFIED** | route in `src/server.js`; not yet probed on a running instance |
| The agent → channel mapping names real channels | **SOURCE_VERIFIED** | `tests/phase75-channels.test.js` validates every id against the catalog |
| A webhook receiver, signature check or dedupe | **NOT_IMPLEMENTED** | no code exists |
| Per-application credentials | **NOT_IMPLEMENTED** | see §7 |
| Any call to the Graph API | **NOT_IMPLEMENTED** | no code exists |
| A Messenger / comment / WhatsApp reply delivered end-to-end | **NOT_TESTED** | nothing is built |
| App Review granted for the scopes in §2–§4 | **UNVERIFIED** | Meta-side, outside our control |
| Bengali speech-to-text and text-to-speech on a real device | **NOT_TESTED** | a browser probe found zero Bengali voices on the connected browser |

---

## 9. Where to start, how, and where to end

Build in this order. Each step ends with a test, a live probe, and a document
update — the same loop the rest of the runtime uses.

1. **Per-application credentials (§7).** Nothing else can be verified without it,
   and it is the smallest change: a store, a write-only admin route, and a
   per-call resolution in the MCP adapter.
   *Ends when:* a second application can call the same endpoint with a different
   token and the log shows the right one for each.
2. **The webhook receiver (§6).** Channel-agnostic: receive, verify the
   signature against the raw body, dedupe, hand off. It must refuse an unsigned
   body, and a replayed body must not produce a second reply.
   *Ends when:* a replayed payload produces exactly one hand-off.
3. **Messenger (§2).** The simplest channel: one window, one endpoint, one
   dedupe key.
   *Ends when:* a real message gets a real reply inside the window, and a message
   outside the window is refused by our own check, with the reason logged.
4. **Comments (§3).** Public reply, then the private reply with its one-message
   and 7-day limits.
   *Ends when:* the second private reply attempt is refused by our own check
   rather than by Meta.
5. **WhatsApp (§4).** The 24-hour window and the template fallback. Template
   approval is a Meta-side dependency; build the code path and mark the outcome
   `UNVERIFIED` until a template is approved.
6. **Ads insights (§5).** Pull-only, read-only, one scope.
   *Ends when:* a client's own ad account returns numbers and the operator's
   account is provably never touched.

Do **not** start with the reply text. The interesting part is the window, the
dedupe and the credential — a working reply with a broken window is a violation,
and a broken window is invisible until Meta acts on it.

---

## 10. Related documents

- `docs/LARAVEL_INTEGRATION.md` — the HTTP contract the shop's Laravel
  application uses. §11 covers the external capability endpoints; §18 covers the
  multi-tenant service model.
- `docs/DESIGN_FLOW.md` — the engineering contract: what each piece is, why it
  is that way, and what is honestly not done. §6 lists the open items.
- `src/channels/catalog.js` — this plan as data.
- `external-mcp/README.md` — how an external MCP endpoint is declared and
  discovered.
