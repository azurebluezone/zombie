# External MCP registry surface

This directory is the runtime-owned declaration surface for external MCP servers.

- `servers.json` contains non-secret endpoint declarations.
- Environment variables are a fallback when a database record is absent.
- Database endpoint records remain authoritative once registered.
- Secrets/tokens must not be placed in this file.
- Discovery is evidence; declaration alone is not a health claim.
