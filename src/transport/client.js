import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function jsonBody(value) { return Buffer.from(JSON.stringify(value ?? {})); }

export class RuntimeClient {
  constructor({baseUrl='http://127.0.0.1:9999', apiKey='', socketPath=null, timeoutMs=120000}={}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  _requestOptions(pathname, method='POST', body=null, {stream=false, headers={}}={}) {
    const u = new URL(pathname, this.baseUrl);
    const payload = body === null ? null : jsonBody(body);
    const useUds = Boolean(this.socketPath);
    const isHttps = u.protocol === 'https:';
    if (useUds && isHttps) throw new Error('uds_and_https_are_mutually_exclusive');
    const options = {
      method,
      protocol: useUds ? 'http:' : u.protocol,
      hostname: useUds ? undefined : u.hostname,
      port: useUds ? undefined : (u.port || (isHttps ? 443 : 80)),
      path: `${u.pathname}${u.search}`,
      socketPath: useUds ? this.socketPath : undefined,
      headers: {
        accept: stream ? 'text/event-stream' : 'application/json',
        ...(payload ? {'content-type':'application/json','content-length':payload.length} : {}),
        ...(this.apiKey ? {authorization:`Bearer ${this.apiKey}`} : {}),
        ...headers
      },
      timeout: this.timeoutMs
    };
    return {options, transport: useUds ? 'uds' : (isHttps ? 'https' : 'http'), payload};
  }

  request(pathname, body=null, options={}) {
    const {options:requestOptions, transport, payload} = this._requestOptions(pathname, 'POST', body, options);
    const requestFn = transport === 'https' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = requestFn(requestOptions, res => {
        let raw='';
        res.setEncoding('utf8');
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          let parsed = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch {}
          if (res.statusCode >= 400) {
            const error = new Error(parsed?.message || parsed?.error || `http_${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.body = parsed;
            reject(error); return;
          }
          resolve({statusCode:res.statusCode, headers:res.headers, data:parsed});
        });
      });
      req.on('timeout', () => req.destroy(new Error('runtime_client_timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  chatCompletions(input) { return this.request('/v1/chat/completions', input); }
  executionRun(input) { return this.request('/v1/execution/run', input); }
  health() {
    const {options:requestOptions, transport} = this._requestOptions('/health', 'GET', null);
    const requestFn = transport === 'https' ? httpsRequest : httpRequest;
    return new Promise((resolve,reject) => {
      const req=requestFn(requestOptions,res=>{let raw='';res.setEncoding('utf8');res.on('data',c=>raw+=c);res.on('end',()=>{try{resolve(raw ? JSON.parse(raw) : null);}catch(error){error.code='runtime_health_invalid_json';reject(error);}});});
      req.on('error',reject); req.end();
    });
  }

  async *stream(pathname, input) {
    const {options:requestOptions, transport, payload} = this._requestOptions(pathname, 'POST', {...input, stream:true}, {stream:true});
    const requestFn = transport === 'https' ? httpsRequest : httpRequest;
    const response = await new Promise((resolve,reject) => {
      const req=requestFn(requestOptions,res=>resolve({req,res}));
      req.on('timeout',()=>req.destroy(new Error('runtime_client_timeout')));
      req.on('error',reject); req.write(payload); req.end();
    });
    const {res}=response;
    if (res.statusCode >= 400) {
      let raw=''; for await (const chunk of res) raw += chunk;
      let parsed=raw; try { parsed=JSON.parse(raw); } catch {}
      const error=new Error(parsed?.message || parsed?.error || `http_${res.statusCode}`); error.statusCode=res.statusCode; error.body=parsed; throw error;
    }
    let buffer='';
    for await (const chunk of res) {
      buffer += chunk.toString();
      const frames=buffer.split('\n\n'); buffer=frames.pop() ?? '';
      for (const frame of frames) {
        const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
        const event=frame.split('\n').find(x=>x.startsWith('event:'))?.slice(6).trim() ?? 'message';
        if (!data) continue;
        if (data === '[DONE]') return;
        let value=data; try { value=JSON.parse(data); } catch {}
        yield {event,data:value};
      }
    }
  }

  streamChatCompletions(input) { return this.stream('/v1/chat/completions', input); }
  streamExecution(input) { return this.stream('/v1/execution/stream', input); }
}

export function createRuntimeClient(options={}) { return new RuntimeClient(options); }
