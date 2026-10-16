# Legacy API Feature Inventory

`api.md` is no longer a runtime dependency. It is treated as a legacy capability inventory.

## Stage 1 — Inventory / boundary
Every legacy capability must have a visible modular target and an explicit status:

- `PRESENT` — a modular boundary exists.
- `PARTIAL` — a related modular boundary exists, but legacy behavior parity is not established.
- `WARNING` — the capability is known but its modular boundary is incomplete or needs review.
- `NOT_IMPLEMENTED` — the capability has no modular implementation yet.

Stage 1 does **not** migrate legacy logic and does **not** claim parity.

## Stage 2 — Logic reconciliation
Only after the inventory is complete, compare the legacy implementation/theory against the modular boundary and decide what logic should be migrated, redesigned, or intentionally retired.
