import { OpenAIFamilyProvider } from './openai-family.js';
export class CloudflareProvider extends OpenAIFamilyProvider {
  constructor(options={}) { super({ ...options, name:'Cloudflare Workers AI', baseUrl:options.baseUrl }); }
}
