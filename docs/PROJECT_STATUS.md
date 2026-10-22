# Project status — 2026-10-22

> **এই ডকুমেন্টই resume point.** নতুন কাজ শুরু করার আগে এই ফাইলটা পড়ো, তারপর
> কোড আর টেস্ট চালিয়ে সংখ্যাগুলো মিলিয়ে নাও। কোড আর এই ডকুমেন্টের মধ্যে
> অমিল থাকলে **কোড জেতে** — এই ফাইল তখন ভুল, ঠিক করে নিতে হবে।
>
> Baseline: tool access `4fa1946`; agent scope + this update: পরের commit।
> Runtime: `/home/xubuntu/zombie`, v0.49.0, API `127.0.0.1:9999`.
> Admin UI (dev): `http://127.0.0.1:8088`; nginx edge: `https://192.168.1.144:8443`.

---

## 0. এক নজরে

| বিষয় | এখনকার অবস্থা | প্রমাণ |
| --- | --- | --- |
| Tests | **428/428 pass, 0 fail, 0 skip, exit 0** | `npm test`, 2026-10-22 |
| Runtime | active, `/health` 200 | `systemctl is-active`, `curl /health` |
| Execution mode | `tools-enabled` | `/health.executionMode` |
| Tool access mode | **`unrestricted` (new default)** | `/health.toolAccessMode`, `/v1/admin/tools/permissions` |
| Runnable tools | 28 | `/v1/admin/registry/tools` |
| Agents | **12, সবগুলো `working-directory` (global 0)** | SQLite `agents.tool_boundary`, `/v1/admin/agents` |
| Providers | 4 registered; Gemini live probe এখন quota-blocked | `/v1/admin/providers`, journal |
| Admin UI | external client, base URL + token only | `admin-ui/index.html` |
| Remote | HEAD == origin/main, dirty 0 | `git rev-parse` |

**সবচেয়ে বড় বাকি ঝুঁকি:** inbound MCP server-এ `TOOL_ACCESS_MODE=unrestricted`
path boundary-ও খুলে দেয় (`/mcp` handler), যদিও agent chat/execution এখন pinned।
§6 P0.2 দেখো। Agent scope-এর single-root tradeoff §6 P1-এ আছে।

---

## 1. মূল লক্ষ্য (যা থেকে কাজ শুরু হয়েছিল)

1. Runtime শুধু pure API থাকবে; admin UI আলাদা client, কোনো CDN/bundled frontend নয়।
2. Provider/model/agent/tool সব admin UI থেকে manage হবে; key শুধু env-এ।
3. Provider যোগ/এডিটে Connection probe করবে, vendor model list আনবে, 6h cache।
4. Model enable/disable + editable prompt দিয়ে test।
5. Agent-এর public identity vs operator route; persona edit/new/enable-disable;
   chat test + real tool-calling test।
6. Tool enable/disable আসল execution gate হবে।
7. Health/test response popup-এ View/JSON।
8. DB bootstrap নিজে নিজে সব table/column বানাবে, manual migration নয়।
9. প্রতিটি step commit + push।
10. Provider model picker-এ একাধিক model select করে subset save।
11. প্রতিটি agent সঠিক context অনুযায়ী যেকোনো tool ব্যবহার করতে পারবে;
    "Context empty" ঠিক হবে।

---

## 2. যা ডেলিভার হয়েছে

### 2.1 Admin console

- `admin-ui/index.html` — external, responsive, token in memory only.
- Providers: add/edit modal, Connection probe, vendor model list, 6h cache,
  1–10 unique priority, env-only keys। API key body-তে দিলে
  `400 provider_keys_are_env_only`.
- Models: Sync from env, per-model enable/disable (`disabledModels`), editable
  prompt দিয়ে test।
- Agents: live/route status, public `zombiecoder/<agentId>` vs upstream route,
  persona edit/new/enable-disable, chat + real tool test.
- Tools: enable/disable switch registry status বদলায়; execution শুধু
  REGISTERED/ENABLED/VERIFIED নেয়।
- Health/test response Viewer: View + JSON tabs।
- Provider model picker: checkbox multi-select + default radio + Select all /
  Clear; PATCH শুধু `providerSelectedModels` পাঠায়।
- Tools page এখন access mode দেখায় (`#toolsMode`), Overview card-এও mode আছে।

### 2.2 Provider/model state

- `custom-openai` provider (priority 4), key `PROVIDER_KEY_CUSTOM_OPENAI`,
  base URL env `CUSTOM_OPENAI_BASE_URL`; seed-এ `baseUrlEnv`, env jitলে।
- Live priorities: gemini 1, groq 2, ollama-cloud-openai 3, custom-openai 4,
  ollama-selfhosted 10 (disabled)।
- Provider key naming: `PROVIDER_KEY_<ID_UPPER_SNAKE>`; কোনো key chat-এ print নয়।

### 2.3 Agent/persona/system prompt

- `AgentRunner.prepare` agent + persona resolve করে
  (`src/agents/runner.js:5-6`)।
- `buildSystemMessage` constitution + identity + persona + tools + compiled
  context একত্র করে (`src/agents/system-prompt.js:172`); identity block line 90।
- Admin agent test এখন **একই pipeline** চালায়: scope → auto-setup →
  SSOT/syllabus/memory → `compileContext` → `buildSystemMessage` → tool surface
  (`src/server.js:1270`, `:1276`)।
- Test body: `projectRoot`, `toolIds`, `allTools` support করে।
- Response-এ `context` summary + `compiled` + persona + prompt bytes/preview +
  tool surface + taskPolicy।

### 2.4 Context pipeline ("Context empty" fix)

- Admin test আগে শুধু persona text + prompt পাঠাত; scope/SSOT/syllabus/memory
  বাদ যেত।
- এখন plain chat-এ `context.compiled` populated (`src/server.js:2082`);
  tool-loop meta-তেও summary (`:1914`)।
- `compiledContextSummary` (`src/server.js:489`) bounded summary দেয়:
  bytes, projectRoot, SSOT/syllabus/memory count, persona, tool surface।
- Live: chat context 618B, SSOT 1 section, prompt 10580B; tool-all 911B,
  28/28 offered, prompt 11279B (provider quota-র আগে মাপা)।

### 2.5 Tool access (এই commit-এর মূল পরিবর্তন)

- আগে `TOOL_ACCESS_MODE` unset ⇒ `permissioned` ⇒ প্রতি app-কে tool grant
  দিতে হতো, নাহলে `tool_not_permitted`।
- এখন default **`unrestricted`**: per-application grant gate নেই; config-এ
  disable করা tool তখনো refuse হয়; agent-এর path scope আগের মতোই থাকে
  (`src/tools/policy.js`, `src/mcp/permissions.js`)।
- Typo fail-closed: exact `unrestricted` ছাড়া অন্য যেকোনো value ⇒
  `permissioned` (`src/config/env.js:207-213`)।
- `/health`-এ `toolAccessMode`, `/v1/admin/tools/permissions`-এ
  `accessMode` + `grantsRequired` যোগ হয়েছে।
- `.env.example` ও live `.env` (`TOOL_ACCESS_MODE=unrestricted`) update করা;
  `.env` gitignored, তাই deploy-এ আলাদা করে set করতে হবে।
- Live proof: **grant ছাড়া app** দিয়ে `/v1/execution/run` →
  `runtime_echo` echo `no-grant-ok`, HTTP 200, app-এর grants 0।

### 2.6 Agent scope (P0.1 — resolved)

- Default boundary এখন **`working-directory`** (`src/agents/access.js`); `global`
  শুধু explicit operator choice। নতুন/unconfigured agent host পায় না।
- Stored directory না থাকলে fallback: `AGENT_DEFAULT_WORKING_DIRECTORY` → `DATA_DIR`;
  caller-এর `projectRoot` কখনোই fallback নয়।
- `AGENT_DEFAULT_WORKING_DIRECTORY` env যোগ হয়েছে (`src/config/env.js`); live value
  `/home/xubuntu/Documents`।
- Admin UI-তে **Scope** editor (boundary select + directory + effective path);
  Agents table-এ pinned/global badge ও effective root; global agent থাকলে
  unrestricted mode-এ warning।
- PATCH `/v1/admin/registry/agents/{id}/boundary` এখন absolute + existing directory
  validate করে: `working_directory_not_absolute`, `working_directory_not_found`,
  `working_directory_not_directory`।
- Live migration: 12/12 agent PATCH করে `/home/xubuntu/Documents`-এ pin; global 0।
- Boot audit: `runtime.agent_scopes` (total/pinned/global/default), এবং
  unrestricted + global থাকলে `runtime.agent_scope_unsafe` warning।

### 2.7 Storage/schema

- Declarative SQLite: `BASE_COLUMNS`, `TABLE_COLUMNS`, `EXTRA_COLUMNS`,
  `INDEXES`; `init()` table বানায়, `_ensureColumns()` typed missing column
  যোগ করে।
- Live DB: `data/runtime.sqlite`, 21 tables.
- `/tmp` service-এর জন্য invisible (`PrivateTmp=yes`); sandbox
  `data/toolcheck-1792691854`-এ রাখতে হয়।

---

## 3. Management map — session থেকে system prompt

| স্তর | কোথায় | কী হয় |
| --- | --- | --- |
| Session | `src/session/service.js:6` | `applicationId` বাধ্যতামূলক, `userId` nullable, metadata sanitize, status `active` |
| Session append | `src/session/state.js:14` | ownership check; `session-messages` store |
| Metadata | `src/session/metadata.js:1` | ১৭ key allowlist; অজানা key drop |
| Header metadata | `src/server.js:2022` | chat/execution header → metadata (sessionSource, clientId, editor, OS…) |
| Session resolve | `src/server.js:2021` | `input.sessionId` হলে owned session; `createSession` হলে নতুন |
| User/tenant | `src/admin/admin-service.js:60` | application = tenant/user record; `users` alias `src/server.js:715` |
| Persona/agent | `src/agents/runner.js:5-6` | registry + persona resolve |
| Identity | `src/agents/system-prompt.js:90` | core identity block |
| System prompt | `src/agents/system-prompt.js:172` | constitution + identity + persona + tools + compiled context |
| Chat compile | `src/server.js:2042` | recent + memory + SSOT + syllabus + facts |
| Chat prompt | `src/server.js:2047` | plain chat system message |
| Chat response | `src/server.js:2082` | `context.compiled` + meta context |
| Tool loop meta | `src/server.js:1914` | context summary + toolSurface + evidence |
| Admin test | `src/server.js:1270` / `:1276` | একই pipeline + `contextView` |
| Tool decision | `src/tools/policy.js` | config disable → grant gate → allow |
| MCP decision | `src/mcp/permissions.js` | same access mode |

**গুরুত্বপূর্ণ:** `userId` nullable, তাই admin-created session-এ human user bind
থাকে না। ভবিষ্যতে per-user audit চাইলে session create-এ `userId` বাধ্যতামূলক
করা আলাদা কাজ।

---

## 4. সিদ্ধান্ত ও invariant

1. Provider key শুধু env; body-তে key = 400। কোনো key log/chat-এ নয়।
2. Provider id থেকেই env var name: `PROVIDER_KEY_<ID_UPPER_SNAKE>`।
3. Base URL env-এ; seed-এ `baseUrlEnv`, env না থাকলে seed skip।
4. Public model `zombiecoder/<agentId>`; upstream route operator-only।
5. **পাঁচটা আলাদা gate:** execution mode → agent path scope → tool config
   disable → (per-app grant, শুধু permissioned) → consent/task policy।
   একটাকে আরেকটা ভেবে ভুল করো না।
6. `TOOL_ACCESS_MODE` এখন tool **access** ঠিক করে, agent-এর **path scope** নয়
   (chat/execution-এ path আসে agent scope থেকে)। Inbound MCP server-এ এখনো
   এই switch path boundary-ও ঠিক করে — §6 P0.2।
7. `TOOL_SURFACE_MODE=narrowed` কী **offer** হবে ঠিক করে, কী **allowed** তা নয়;
   `toolIds`/`toolSurface:"full"` opt-out।
8. Admin agent test provider-কে সরাসরি call করে, tool **execute** করে না।
9. DB bootstrap runtime-এ; manual migration নয়। `EXTRA_COLUMNS` অবশ্যই
   `{column: type}`।
10. `.env` boot-এ load; edit করলে restart লাগে।
11. Agent default boundary `working-directory`; unset directory
    `AGENT_DEFAULT_WORKING_DIRECTORY` → `DATA_DIR`, caller root নয়। Stored scope
    absolute + existing directory হতে হবে; relative path 400।

---

## 5. Verification (fresh, 2026-10-22)

```
npm test
exit=0
tests 428 / pass 428 / fail 0 / skipped 0
```

- `tests/phase81-tool-access-mode.test.js` — 3/3: permissioned grant লাগে;
  unrestricted grant ছাড়া allow; config disable তখনো block; MCP একই নিয়ম।
- `tests/phase58-mcp-server.test.js` — 8/8; grant-gate test এখন স্পষ্টভাবে
  `TOOL_ACCESS_MODE=permissioned` pin করে।
- `tests/phase48-admin-control-plane.test.js` — 2/2; agent test context +
  plain chat `context.compiled` + `meta.context` assertion; pinned default root
  (`DATA_DIR`) asserted.
- `tests/phase82-agent-scope.test.js` — 5/5: default pinned; caller root ignored;
  unset directory falls back to workspace; global explicit; live boundary PATCH,
  relative-path 400, inside read 200, `/etc/passwd` refused; a symlinked scope is
  stored canonically (realpath), so repointing the link cannot move the boundary।

Live:

| Probe | ফল |
| --- | --- |
| `/health` | 200, `executionMode=tools-enabled`, `toolAccessMode=unrestricted` |
| `/v1/admin/tools/permissions` | `accessMode=unrestricted`, `grantsRequired=false`, grants 0 |
| Grant ছাড়া `/v1/execution/run` (`runtime_echo`) | HTTP 200, nested `result.result.echo=no-grant-ok`, `result.status=awaiting_verification` (evidence observed, independently verified নয়) |
| Admin agent test context | `context.available=true`; chat 618B / SSOT 1 / prompt 10580B; tool-all 911B / 28/28 / prompt 11279B |
| Admin agent test provider call | **provider_http_error** (Gemini quota 429) — fresh model completion **NOT_TESTED** |
| UI | `toolsMode` marker served; mode `unrestricted` দেখায়; Scope editor markers served |
| Scope PATCH (live) | 12/12 → `working-directory`, `/home/xubuntu/Documents`; global 0 |
| Boot audit | `runtime.agent_scopes` → total 12, pinned 12, global 0; কোনো unsafe warning নেই |
| Boundary tool probe | throwaway app (0 grants), `read_file` `Default Project/.zombiecoder/SSOT.md` → 200; `/etc/passwd` → 400 `execution_path_outside_project_root` |
| Relative scope PATCH | 400 `working_directory_not_absolute` |

**Label discipline:** উপরের context/policy অংশ `LIVE_PROBE_PASSED`; model
completion `NOT_TESTED` (upstream quota); 28/28 surface `LIVE_PROBE_PASSED`;
`verified:false` মানে success নয়।

---

## 6. খোলা সমস্যা (priority অনুযায়ী)

### P0 — security / trust boundary

1. **✅ RESOLVED — 12/12 agent `tool_boundary=global`।**
   - এখন 12/12 `working-directory`, `/home/xubuntu/Documents`; global 0।
   - নতুন agent default pinned; unset directory workspace fallback; UI Scope editor;
     boot `runtime.agent_scope_unsafe` warning।
   - Live proof: boundary-র বাইরে `read_file /etc/passwd` → 400
     `execution_path_outside_project_root`; ভিতরে SSOT read → 200।
2. **Inbound MCP server path widening (এখনো খোলা)।** `/mcp` handler
   (`src/server.js:258-261`) `TOOL_ACCESS_MODE=unrestricted` হলে
   `allowAnyRoot/allowAnyPath/allowAnyCommand=true` করে। Agent chat/execution
   এটা করে না, কিন্তু MCP server আলাদা surface।
   - Fix: `MCP_SERVER_PROJECT_ROOT`-কে সবসময় boundary করা, অথবা আলাদা
     `MCP_SERVER_PATH_MODE`; unrestricted শুধু grant gate-এ সীমিত রাখা।
   - Acceptance: unrestricted + MCP call root-এর বাইরে deny; test।

### P1 — functionality / operations

3. **Provider quota**: Gemini 429; fresh chat/tool completion এখন
   `NOT_TESTED`। কোড ঠিক আছে, কিন্তু live model proof quota reset-এ আবার চালাতে হবে।
4. **Admin test tool execute করে না** — শুধু provider call + tool schema।
   "tool actually ran" প্রমাণ করতে `/v1/execution/run` probe ব্যবহার করো।
5. **Consent/task policy** — write/command-এ `consent:true` লাগে; admin UI-তে
   execution test-এর consent toggle নেই (test execute করে না বলে এখন blocker নয়)।
6. **nginx TLS self-signed** — browser 직접 খুললে cert exception লাগে;
   dev-এ `http://127.0.0.1:8088` ব্যবহার করছি।
7. **Tool mode visibility** — admin UI-তে per-app grant list নেই; API
   `/v1/admin/tools/permissions` আছে, unrestricted-এ প্রায় অপ্রয়োজনীয়।
8. **Single-root tradeoff** — সব agent `/home/xubuntu/Documents`-এ pinned। অন্য
   root (যেমন runtime repo `/home/xubuntu/zombie`) দরকার হলে operator-কে Scope
   editor/PATCH দিয়ে বদলাতে হবে; এক agent-এর জন্য একাধিক root allowlist এখনো নেই।
   Multi-root scope ভবিষ্যতের কাজ, কিন্তু এখন least privilege বজায় রাখে।

### P2 — polish / docs

9. Agent test result table-এ দেখা যায় না, শুধু popup।
10. `docs/JOURNEY.md` §2-এর measured numbers 2026-10-17-এর; এই ডক এখন resume
   point, JOURNEY history।
11. `/tmp` invisible (PrivateTmp); sandbox path `data/`-এর ভিতরে রাখতে হবে।
12. Secret incident: একটা throwaway app key একবার tool output-এ এসেছিল;
    app সাথে সাথে revoke; key file remove। ভবিষ্যতে app create-এর response
    কখনো print না করে সরাসরি file-এ লেখো।
13. 28 tools offered, কিন্তু narrowed selection default 12-cap; দরকারে
    `toolSurface:"full"`।

---

## 7. পরবর্তী পরিকল্পনা (ক্রম অনুযায়ী)

1. **P0.2 MCP path decoupling** — inbound MCP-কে agent scope বা explicit root-এ
   সীমিত করা; unrestricted-এ `allowAny*` না করা। মাপকাঠি: root-এর বাইরে deny।
2. **Provider live proof** — quota reset হলে code-guru chat + tool call;
   মাপকাঠি: `content` non-null, `toolCallCount>=1`, `context.available=true`।
3. **Consent/tool execution UX** — admin test-এ optional "execute with consent"
   (আলাদা explicit checkbox), অথবা execution probe shortcut।
4. **Grant visibility** — Tools page-এ per-app grants table + "grant all"
   (permissioned mode-এর জন্য)।
5. **Multi-root scope (design)** — এক agent एकাধিক root (allowlist) নাকি single
   root; decision + test। এখন single-root intentionally।
6. **TLS** — trusted cert বা browser exception; nginx-এ admin UI verify।
7. **Docs** — প্রতি বড় step-এ এই ফাইলের snapshot + commit hash update।

---

## 8. Resume checklist

```bash
cd /home/xubuntu/zombie

# state
git rev-parse HEAD && git status --porcelain=v1
systemctl is-active zombiecoder-runtime
curl -s http://127.0.0.1:9999/health | python3 -m json.tool | head -20

# tests (expect 428/428, exit 0)
npm test

# logs
journalctl -u zombiecoder-runtime -n 50 --no-pager

# admin UI (dev)
# http://127.0.0.1:8088  → base URL http://127.0.0.1:9999 + ADMIN_TOKEN
```

- `.env` gitignored; deploy-এ `TOOL_ACCESS_MODE` ও
  `AGENT_DEFAULT_WORKING_DIRECTORY` আলাদা করে set করতে হবে।
- Agent scope বদলাতে admin UI → Agents → Scope, অথবা
  `PATCH /v1/admin/registry/agents/{id}/boundary`
  `{ "toolBoundary": "working-directory", "workingDirectory": "/absolute/path" }`।
  Absolute + existing directory না হলে 400।
- Provider key কোথাও print করবে না; app create-এর response file-এ লিখে
  সাথে সাথে revoke/remove।
- `npm run build` → `systemctl restart zombiecoder-runtime` (src বদলালে)।
- `dist/` build artifact; service সেখান থেকেই চলে।

---

## 9. Commit trail (সাম্প্রতিক)

| Commit | কী |
| --- | --- |
| `596b1ff` | test: meta.context compiled assertion |
| `86856f9` | agent test real context pipeline + compiled context responses |
| `4bcd255` | multi-select provider model picker |
| `f2c7daf` | declarative SQLite schema, env base URL, generic custom provider |
| `99472d7` | admin UI redesign, provider modal/probe, agent/tool tests |
| `4fa1946` | tool access default `unrestricted`; status doc, changelog, docs |
| `1a5fce8` | storage durability + consistent backups |
| `8f42425` | nginx edge TLS + control-plane rate limit |

এই ডকুমেন্টের সর্বশেষ update agent-scope commit-এ; hash commit trail-এ যোগ করা হবে।

---

## 10. দ্রুত শব্দার্থ

- **SSOT** — project-এর single source of truth, auto-setup generate করে।
- **compiled context** — model যে bounded document পায় (facts, SSOT, syllabus,
  memory, recent)।
- **tool surface** — model-কে কী tools *offer* করা হয়; permission নয়।
- **permissioned** — প্রতি app-কে explicit tool grant লাগে।
- **unrestricted** — grant gate নেই; config disable/path scope/consent আগের মতো।
- **global / working-directory** — agent-এর path scope।
- **verified** — evidence gate success claim করতে পারে; `observed` মানে
  execution হয়েছে, independent verification হয়নি।
