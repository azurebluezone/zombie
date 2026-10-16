import { OllamaProvider } from './ollama.js';
import { GeminiProvider } from './gemini.js';
import { GroqProvider } from './groq.js';
import { CloudflareProvider } from './cloudflare.js';
import { OpenAIFamilyProvider } from './openai-family.js';

export function createProviderAdapter(item, config={}) {
  const networkPolicy = config.providerNetworkPolicy ?? {};
  const driver = item.driver ?? item.type ?? 'openai-compatible';
  const apiKey = config.providerApiKeys?.[item.id] ?? item.apiKey ?? '';
  // Provider call budget: adapters fall back to their own default when this is unset.
  const configuredTimeoutMs = Number(config.providerTimeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : undefined;
  let adapter;
  if (driver === 'ollama') adapter = new OllamaProvider({...item, apiKey, baseUrl:item.baseUrl, networkPolicy, timeoutMs});
  else if (driver === 'gemini') adapter = new GeminiProvider({...item, apiKey, networkPolicy, timeoutMs});
  else if (driver === 'groq') adapter = new GroqProvider({...item, apiKey, networkPolicy, timeoutMs});
  else if (driver === 'cloudflare') adapter = new CloudflareProvider({...item, apiKey, networkPolicy, timeoutMs});
  else adapter = new OpenAIFamilyProvider({...item, apiKey, networkPolicy, timeoutMs});
  // A provider's explicit manifest capabilities override adapter defaults. This lets
  // small models use strict-JSON tool requests without sending unsupported native tools.
  if (Array.isArray(item.capabilities) && item.capabilities.length) {
    adapter.capabilities.functionCalling = item.capabilities.includes('function-calling');
    adapter.capabilities.streaming = item.capabilities.includes('streaming');
    adapter.capabilities.models = item.capabilities.includes('model-catalog');
    adapter.capabilities.chatCompletions = item.capabilities.includes('chat-completions') || driver === 'gemini';
  }
  return adapter;
}
