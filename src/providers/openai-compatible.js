import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { RUNTIME_USER_AGENT } from '../runtime/version.js';

function requestJson(urlString, method, payload = undefined, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? httpsRequest : httpRequest;
    if (!['http:', 'https:'].includes(url.protocol)) return reject(new Error('provider_url_must_be_http_or_https'));
    const data = payload === undefined ? null : JSON.stringify(payload);
    const reqHeaders = { accept: 'application/json', 'user-agent': RUNTIME_USER_AGENT, ...headers };
    if (data !== null) {
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = Buffer.byteLength(data);
    }
    const req = client(url, { method, timeout: timeoutMs, headers: reqHeaders }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; if (raw.length > 2_000_000) req.destroy(new Error('provider_response_too_large')); });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { return reject(new Error('provider_invalid_json')); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error('provider_http_error'); err.statusCode = res.statusCode; err.providerBody = parsed; return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('provider_timeout')));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

export class OpenAICompatibleProvider {
  constructor({ id, name, baseUrl, apiKey = '', defaultModel = '', timeoutMs = 30000 }) {
    this.id = id;
    this.name = name ?? id;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
    this.timeoutMs = timeoutMs;
  }

  headers() { return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}; }

  async listModels() {
    return requestJson(`${this.baseUrl}/models`, 'GET', undefined, this.headers(), this.timeoutMs);
  }

  async chatCompletions(input) {
    const payload = { ...input, model: input.model ?? this.defaultModel };
    delete payload.provider;
    if (!payload.model) throw new Error('provider_model_required');
    return requestJson(`${this.baseUrl}/chat/completions`, 'POST', payload, this.headers(), this.timeoutMs);
  }
}
