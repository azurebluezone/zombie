import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
export const RUNTIME_VERSION = String(pkg.version);
export const RUNTIME_PHASE = Number(RUNTIME_VERSION.split('.')[1] ?? 0);
// Sent on every outbound provider/MCP request so upstreams can attribute and
// rate-limit traffic per client, as expected by common API practices.
export const RUNTIME_USER_AGENT = `ZombieCoder-Runtime/${RUNTIME_VERSION} (+https://zombiecoder.my.id)`;
