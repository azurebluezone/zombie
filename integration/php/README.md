# ZombieCoder PHP Integration

This folder is the server-side integration boundary for PHP/Laravel ecommerce applications.

## Contract

```text
PHP/Laravel application
        |
        | HTTPS + Bearer application key
        v
ZombieCoder Runtime
        |
        +-- application policy
        +-- session/context
        +-- agent/tool boundary
        +-- provider/MCP routing
        +-- evidence/verification
        v
Canonical response + request/trace IDs
```

The PHP application owns the customer-facing workflow. ZombieCoder owns AI/runtime orchestration. The browser must not receive the ZombieCoder application key.

## Required configuration

```env
ZOMBIECODER_BASE_URL=https://runtime.example.internal/v1
ZOMBIECODER_API_KEY=server-side-application-key
ZOMBIECODER_MODEL=approved-model-id
```

## Failure rule

A PHP integration must not turn an unverified runtime result into a successful business action. For example, an AI response that merely says an order is available is not proof that the ecommerce database actually contains that stock.

Use the returned `request_id` and `trace_id` when investigating a failure. Never log the API key or raw customer payload.
