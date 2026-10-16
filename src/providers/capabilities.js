export const PROVIDER_CAPABILITIES = Object.freeze({
  chatCompletions: 'chat-completions',
  generateContent: 'generate-content',
  streaming: 'streaming',
  functionCalling: 'function-calling',
  models: 'model-catalog'
});

export function requireCapability(adapter, capability) {
  if (!adapter?.capabilities?.[capability]) throw new Error(`provider_capability_not_supported:${capability}`);
  return true;
}
