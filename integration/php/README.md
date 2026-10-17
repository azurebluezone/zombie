# ZombieCoder PHP Integration

This folder is the server-side integration boundary between a PHP/Laravel
ecommerce application and the ZombieCoder Runtime. It contains two
dependency-free clients — no Composer package is required.

| File | Credential | Use it for |
| --- | --- | --- |
| `ZombieCoderClient.php` | one shop's **application key** | chat, streaming chat, sessions |
| `ZombieCoderAdminClient.php` | the operator's **admin token** | create/revoke/extend applications, set feature switches, grant tools and MCP endpoints |

**Never put the admin token in a shop's application.** A shop gets an
application key and nothing else; it can only act for its own application. Every
`/v1/admin/*` route is authorised by the admin token, so an application key
cannot reach the operator's control plane.

## Contract

```text
Client shop (Laravel)                 Operator control plane
        |                                      |
        | HTTPS + application key              | HTTPS + admin token
        v                                      v
   ┌──────────────────────────────────────────────────────┐
   │                 ZombieCoder Runtime                  │
   │  application policy · sessions · agent/tool boundary │
   │  provider routing · MCP client · evidence/verification│
   └──────────────────────────────────────────────────────┘
        |
        v
Canonical response + request/trace IDs
```

The shop owns the customer-facing workflow and the customer data. The runtime
owns AI orchestration. The browser must never receive the application key.

## Configuration

**Shop** (`.env` on the shop's host):

```env
ZOMBIECODER_BASE_URL=https://runtime.example.internal/v1
ZOMBIECODER_API_KEY=zc_…            # this shop's key, server-side only
ZOMBIECODER_MODEL=zombie-mini
ZOMBICODER_AGENT=customer-experience-specialist
ZOMBICODER_TIMEOUT=60
```

**Operator** (`.env` on the control plane only):

```env
ZOMBIECODER_BASE_URL=https://runtime.example.internal/v1
ZOMBIECODER_ADMIN_TOKEN=…           # never leave this host
```

## The shop's calls

```php
$zc = new ZombieCoderClient(
    getenv('ZOMBIECODER_BASE_URL'),
    getenv('ZOMBIECODER_API_KEY'),
    getenv('ZOMBIECODER_MODEL'),
);

// A plain answer.
$result = $zc->chat([['role' => 'user', 'content' => 'আপনার অর্ডার কোথায়?']], [
    'agent' => 'customer-experience-specialist',
    'sessionId' => $sessionId,          // optional
    'userId' => 'PIN-0005',             // the support PIN, not a name
]);

// A streamed answer — push each token to the browser through Pusher.
$stream = $zc->chatStream(
    [['role' => 'user', 'content' => 'ডেলিভারি চার্জ কত?']],
    function (string $delta) use ($channel) {
        // broadcast($delta) on $channel
    },
);
```

A streamed token arrives on the `data:` channel **only**. `event: runtime`
frames are lifecycle metadata and carry no token text — do not concatenate both
channels.

## The operator's calls

```php
$admin = new ZombieCoderAdminClient(getenv('ZOMBIECODER_BASE_URL'), getenv('ZOMBIECODER_ADMIN_TOKEN'));

$created       = $admin->createApplication('Rahim Store', '2026-11-17T00:00:00.000Z');
$applicationId = $created['application']['id'];
$shopKey       = $created['apiKey'];          // shown once — deliver securely

$admin->setTool($applicationId, 'note_store', true);
$admin->grantMcpTool($applicationId, 'mcp_whatsapp_send_message');
```

See `docs/LARAVEL_INTEGRATION.md` §18 for the full multi-tenant contract:
entitlement resolution, expiry enforcement, the support-PIN design, and what is
still `NOT_IMPLEMENTED`.

## Failure rule

A PHP integration must not turn an unverified runtime result into a successful
business action. For example, an AI response that merely says an order is
available is not proof that the ecommerce database actually contains that stock.

Use the returned `request_id` and `trace_id` when investigating a failure. Never
log the API key, the admin token, or a raw customer payload.

## Verification status

The HTTP contract these clients target was probed against a running runtime
(`LIVE_PROBE_PASSED`). The PHP files themselves were **not executed** — no `php`
binary exists on the build host. Run `php -l` and one smoke call before relying
on them.
