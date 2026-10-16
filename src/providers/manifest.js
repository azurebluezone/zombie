import { normalizeManifest } from '../registry/manifest.js';

export function providerManifest(input) {
  return normalizeManifest({
    ...input,
    type: 'provider',
    entry: input.entry ?? 'src/providers/openai-compatible.js',
    capabilities: input.capabilities ?? ['chat-completions'],
    source: input.source ?? 'provider-registry'
  }, 'provider');
}
