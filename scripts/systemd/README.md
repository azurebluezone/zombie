# scripts/systemd

Self-contained systemd artifacts for the ZombieCoder Runtime. No npm packages
are involved; everything here is plain shell/systemd text.

## Files

- `zombiecoder-runtime.service.template` — unit template with `{{PLACEHOLDER}}` tokens.

## Placeholders

| Token | Meaning |
|-------|---------|
| `{{USER}}` | Least-privilege account that owns `data/` and `logs/` |
| `{{ROOT}}` | Absolute path to this repository checkout |
| `{{PORT}}` | Loopback HTTP port (keep `127.0.0.1`; do not expose directly) |
| `{{MODE}}` | `chat-only` (safe default) or `tools-enabled` |
| `{{NODE}}` | Absolute path to a Node.js >= 22.5.0 binary |

## Install

Use the installer, which renders the template and fails closed if any
placeholder is left unresolved:

```bash
sudo bash scripts/setup-os-runtime.sh
```

## Manual render (no sudo)

```bash
sed -e "s|{{USER}}|$USER|g" \
    -e "s|{{ROOT}}|$PWD|g" \
    -e "s|{{PORT}}|9999|g" \
    -e "s|{{MODE}}|chat-only|g" \
    -e "s|{{NODE}}|$(command -v node)|g" \
    scripts/systemd/zombiecoder-runtime.service.template
```

## Verify

```bash
systemd-analyze verify zombiecoder-runtime.service   # static unit check
systemctl daemon-reload && systemctl restart zombiecoder-runtime
systemctl --no-pager --full status zombiecoder-runtime
node scripts/verify-deployment.mjs
```

The runtime binds `127.0.0.1` only. Expose it through the TLS reverse proxy in
`scripts/nginx/zombiecoder.conf.template`; never bind the runtime to a public
interface.
