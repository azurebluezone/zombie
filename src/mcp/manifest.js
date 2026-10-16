import { normalizeManifest } from '../registry/manifest.js';

export function mcpManifest(input) {
  return normalizeManifest({
    ...input,
    type: 'mcp',
    source: input.source ?? 'mcp-registry'
  }, 'mcp');
}
