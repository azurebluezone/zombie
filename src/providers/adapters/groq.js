import { OpenAIFamilyProvider } from './openai-family.js';
export class GroqProvider extends OpenAIFamilyProvider {
  constructor(options={}) { super({ ...options, name:'Groq', baseUrl:options.baseUrl ?? 'https://api.groq.com/openai/v1' }); }
}
