# The journey — plan, where we stand, and what comes next

> **2026-10-22 resume point:** read `docs/PROJECT_STATUS.md` first. It records the
> admin console, context-pipeline and tool-access work, the open P0s, and the next
> plan. The measured section below (§2) predates that work and is kept as history.

This file is a **living record**, not a design document. `docs/DESIGN_FLOW.md` explains why
the runtime is built the way it is; this one answers three plain questions and is meant to be
edited as work moves:

1. What did we set out to do?
2. How far did we get?
3. What is next, and how do we know when it is done?

Every claim here carries an evidence label from `docs/DESIGN_FLOW.md` §2.4. Numbers were
measured, not estimated, and each one can be re-measured with the command next to it. If a
number here and the code disagree, **the code wins** and this file is wrong.

---

## 1. The plan

### 1.1 The business shape

We sell a working Laravel e-commerce project to a shop, at roughly **500–700 BDT per month**
for about ten percent of the features — that is, each client picks about five of ten
available features. Around fifty clients is the target.

The runtime supplies **only three things**: the LLM, the response, and the service. It does not
hold a Meta app, does not hold a client's token, and does not hold customer data. Each client
brings their own Meta app, passes their own App Review, and keeps their own customer records
on their own site. This was decided and recorded as **Path A** in `docs/FACEBOOK_CHANNELS.md`
§1.3; Path B (we hold one Meta app for everyone) was considered and rejected.

The consequence is short: **the runtime is not the door to the client's shop.** The client's
own Laravel is. The runtime only answers when the client's Laravel asks it to.

### 1.2 The engineering plan

- One **user** per client, with one **token**, created from the admin console — and equally
  creatable from a terminal, because the console is a client of the API and never the door to
  it.
- A user carries a **role** (`admin` | `user`), **per-user ceilings**, and a **term** with an
  end date, because the business is monthly and the end date *is* the renewal date.
- The client's Laravel asks the runtime *who is this token and when does their term end* with
  one call, and does everything else itself.
- No deception anywhere: an error names the field that was wrong, a switched-off path says it
  is switched off (`501`) rather than pretending to be missing (`404`), and no evidence is
  claimed that was not observed.

---

## 2. Where we stand (measured 2026-10-17)

| Fact | Value | How to re-measure |
| --- | --- | --- |
| Branch state | `main` at `87620ce`, equal to `origin/main` | `git status -sb` |
| Regression suite | **409 tests, 408 pass, 0 fail, 1 skipped** | `npm test` |
| The skip | PHP syntax check — no `php` binary here, reported `NOT_TESTED` | `npm test \| grep skipped` |
| Zero-dependency rule | clean (no `node_modules`, no lockfile) | `node scripts/check-zero-deps.mjs` |
| Route inventory | 98 concrete routes, 59 handler blocks, 10 notes | `curl -s localhost:9999/v1/admin/routes` |
| User rows in the store | 20 rows: 10 active, 10 revoked (all are our own test rows) | `GET /v1/admin/applications` |
| Gemini | **disabled** in the admin store **and** `enabled:false` in `.env` — the two agree | `GET /v1/admin/providers` |
| Providers actually answering | `groq` and `ollama-cloud-openai` | last `chat.completed` entries in `logs/runtime.jsonl` |

### 2.1 What the log says about real use

The runtime has been up for **12.3 hours across 64 server starts** and has answered **4,231
requests**, including **219 successful chat completions** and **119 completed tool
executions**.

**Every one of those callers was one of our own test rows.** The busiest token in the log is
`local-provider-verify`; no row resembles a real shop. Since the current instance started
(2026-10-17T06:56:54Z) the only requests have been health checks, an admin listing, four
revokes and four deliberate bad-input probes — no chat, no tool call, no client.

That is expected rather than a problem: the runtime binds `127.0.0.1` only, so nothing outside
this machine can reach it at all. The first genuine client traffic will arrive only when a
client's Laravel calls it, which is journey item 1 below.

---

## 3. What is done

Commit ledger, newest first. Each line is on `origin/main`.

| Commit | What it settled |
| --- | --- |
| `87620ce` | **Users and tokens.** Roles, per-user ceilings, terms with an end date, the sealed-at-rest token vault, `GET /v1/auth/verify`, the console as a client of the API with runnable `curl` in the token modal, and error publication by shape instead of a drifting allowlist |
| `3185469` | The two long-standing test failures fixed rather than tolerated (`phase49` negotiation contract, PHP check skips honestly) |
| `c2f333a` | The constitution written down as statements; Path A recorded |
| `b68a86c` | The zero-dependency rule enforced by a script and a test |
| `015ad30` | `docs/FRESH_INSTALL.md` — fresh OS, MCP client connection, post-restart checklist |
| `b6686ff` | The messaging-channel plan as data (`src/channels/catalog.js`), not prose |
| `acdd04b` | One OpenAI error envelope, rewritten for every 4xx/5xx |
| `84980d0` | The seven web/context tools fixed, with coverage |
| `7401386` | The PHP admin client and the multi-tenant section |
| `8f34b9d` | The streaming double-send fix (one token, one channel) |
| `2f7fbc8` | External MCP tools inside the agent tool surface |
| `63d17a1` | The Laravel integration and design-flow documents |
| `84a6e88`, `c094dea`, `0063692`, `e449af4`, `f3b2aef` | Smaller, each settled on its own terms |

The monthly loop a client actually experiences now exists end to end **as an API**:

```bash
# create the user and the term                      → operator, once a month
curl -s -X POST http://127.0.0.1:9999/v1/admin/applications \
  -H 'content-type: application/json' \
  -d '{"name":"client shop","role":"user","limits":{"rateLimit":30},"expiresAt":"2026-11-06"}'

# the client's own Laravel asks who just logged in  → their site, every login
curl -s http://127.0.0.1:9999/v1/auth/verify \
  -H 'authorization: Bearer zc_...'

# renew: move the date, nothing else changes        → operator, next month
curl -s -X PATCH http://127.0.0.1:9999/v1/admin/applications/<id> \
  -H 'content-type: application/json' -d '{"expiresAt":"2026-12-06"}'
```

---

## 4. What is not done — carried forward honestly

| Item | Status | Why it is where it is |
| --- | --- | --- |
| A real Laravel app calling this runtime | **NOT_TESTED** | no `php` and no `composer` on this machine, so the PHP path cannot be executed here. Everything it depends on is END_TO_END_TESTED over HTTP |
| `verifyUser()` helper in `integration/php/ZombieCoderClient.php` | not written | `GET /v1/auth/verify` exists, is documented and is covered over HTTP; the wrapper is convenience, and would ship `NOT_TESTED` |
| Messenger / comment / WhatsApp / Ads replies | declared `PLANNED` | `GET /v1/admin/channels` reports the plan. No webhook receiver, no Graph call, no reply exists. Blocked on each client's own Meta app and App Review. Plan: `docs/FACEBOOK_CHANNELS.md` §9 |
| `facebook-ads` transport | declared `grpc`, refused with `mcp_transport_grpc_requires_bridge` | it points at an internal gRPC service, not the Graph API; needs a JSON/HTTP facade in front of it |
| Per-application MCP credentials | `NOT_IMPLEMENTED` | one credential set per endpoint today, so a per-shop token currently means a per-shop endpoint |
| `public-api`, `tts`, `ocr`, `facebook-ads` | `UNVERIFIED` | declared capabilities, never exercised |
| A stdio→HTTP MCP bridge | not shipped | a stdio-only MCP client cannot connect to this runtime |
| No standalone Chrome | `NOT_TESTED` | the only Chromium here is Electron's, which does not implement `Target.createTarget`; some browser-tool checks stay unverified |
| `scripts/setup-os-runtime.sh` | `NOT_TESTED` | needs Linux + systemd + root |
| ~10 leftover test rows in the store | measured, left in place | they are ours, not a client's; revoke them whenever you like |

---

## 5. The next journey

Ordered by what it unblocks, not by what is easiest. Each item states where to start, how to
know it worked, and the evidence gate that has to pass before it may be called done.

### Journey 1 — a real client app talks to the runtime (highest value)

- **Where to start:** a machine with `php` and `composer`. Read `docs/LARAVEL_INTEGRATION.md`,
  then `integration/php/` and `tests/phase31-php-observability.test.js`.
- **How:** the client's Laravel stores the token from the operator, and on login calls
  `GET /v1/auth/verify`; a page on that app then calls `POST /v1/chat/completions` with the
  same token.
- **How we know:** the app renders the runtime's answer, and the runtime log shows
  `application.auth.succeeded` with an applicationId that is **not** a test row — the first
  real client traffic in §2.1.
- **Evidence gate:** END_TO_END_TESTED, with the client's own app on the other end.
- **Risk:** none to the runtime; this is a client-side integration.

### Journey 2 — one messaging channel, end to end

- **Where to start:** `docs/FACEBOOK_CHANNELS.md` §9. Pick **one** channel, not four.
- **How:** the webhook is received and answered in the **client's** Laravel (Path A), which
  calls the runtime for the reply text. WhatsApp is "your shop's auto-reply", never a general
  assistant.
- **How we know:** a real message on a real page gets a real reply, and the log shows the
  call.
- **Evidence gate:** END_TO_END_TESTED on one channel. The other three stay `PLANNED` until
  then — a declaration is not a health claim.
- **Blocker outside our control:** the client's App Review outcome and timeline.

### Journey 3 — the monthly loop becomes one glance

- **Where to start:** `public/admin/index.html`, `VIEWS.users`. The **Expires** column and the
  `+30 days` / `+1 year` buttons exist; what does not exist is a way to see *only* what is
  ending.
- **How:** a "ending in 7 days" filter or section, and a renew action on the row itself, so
  renewing fifty clients is a list you walk down rather than a search you repeat.
- **How we know:** the operator can answer "who owes me money this week" without reading the
  whole table.
- **Evidence gate:** CONFIG_VALIDATED in a browser, plus the API parity test in
  `tests/phase79-users-over-http.test.js` still passing — a UI-only capability is a defect.

### Journey 4 — per-application MCP credentials

- **Where to start:** `docs/LARAVEL_INTEGRATION.md` §18.7 and `src/mcp/registry.js`.
- **How:** inject each application's own credential at call time instead of one credential set
  per endpoint.
- **Evidence gate:** END_TO_END_TESTED against a real endpoint with two different application
  credentials.

### Journey 5 — the honest gaps with no dependency

- Write `verifyUser()` in the PHP client (ships `NOT_TESTED` until a PHP host exists).
- Revoke the leftover test rows so the store shows only clients.
- Re-measure §2 and correct this file if anything moved.

---

## 6. How to pick this up

```bash
cd /home/xubuntu/zombie
git status -sb                 # expect: clean, main == origin/main
npm test                       # expect: 409 tests, 408 pass, 0 fail, 1 skipped
node scripts/check-zero-deps.mjs
curl -s localhost:9999/health  # if nothing answers: node start.js --stop && npm start

# the operator's own view of the truth
curl -s localhost:9999/v1/admin/routes | head -c 200
curl -s localhost:9999/v1/admin/applications   # who exists, and when each term ends
tail -20 logs/runtime.jsonl
```

Then open the console at `http://127.0.0.1:9999/admin` and read the **Users** view: the
Expires column and the `EXPIRED` marker are the state of the business in one screen.

**Do not** start Journey 1 by reading this file alone. Read `docs/LARAVEL_INTEGRATION.md` and
the code it points at; this file records intent, and the code records behaviour.
