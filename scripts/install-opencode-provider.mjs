#!/usr/bin/env node
// Install the ZombieCoder runtime as an OpenCode V2 provider.
//
// The runtime already exposes an OpenAI-compatible surface with a public agent
// model (`zombiecoder/code-guru`). OpenCode needs three things to use it:
//
//   1. an application key, because /v1/chat/completions is authenticated;
//   2. a key file outside the config, so the token is not written into a file
//      that people share or commit;
//   3. a `providers.zombie` entry with the compatible package and base URL.
//
// This script creates or rotates one named application over the loopback admin
// API, writes the key with mode 0600, then merges the provider into the global
// OpenCode config. The previous config is copied aside first; a JSONC file with
// comments is refused rather than rewritten as plain JSON.
//
// The ZombieCoder plugin can own the global default (`modelStrategy: "free"`).
// The root model is still written as a fallback, but the result line reports
// `default=plugin-managed` and prints the explicit `--model` selection instead
// of claiming a default that the plugin will overwrite.
import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};

const dryRun = flag('dry-run');
const setDefault = !flag('no-default');
const appName = option('app-name', 'opencode-local');
const publicModel = option('model', 'zombiecoder/code-guru');
const providerId = option('provider', 'zombie');
const home = os.homedir();
const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
const configPath = path.resolve(option('config', path.join(configDir, 'opencode.json')));
const keyFile = path.resolve(option('key-file', path.join(configDir, 'zombie.key')));

function parseEnv(text) {
  const values = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const envFile = path.resolve(root, process.env.ENV_FILE || '.env');
const envValues = existsSync(envFile) ? parseEnv(await readFile(envFile, 'utf8')) : {};
const adminToken = process.env.ADMIN_TOKEN || envValues.ADMIN_TOKEN || '';
const host = process.env.HOST || envValues.HOST || '127.0.0.1';
const port = process.env.PORT || envValues.PORT || '9999';
const runtimeHost = ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host;
const runtimeBase = String(option('runtime-url', process.env.ZOMBIECODER_URL || `http://${runtimeHost}:${port}`)).replace(/\/+$/, '');
const baseURL = `${runtimeBase}/v1`;

function fail(message) {
  console.error(`OPENCODE_PROVIDER_FAIL ${message}`);
  process.exit(1);
}

async function request(pathname, options = {}) {
  const headers = {...(options.headers ?? {})};
  if (adminToken) headers.authorization = `Bearer ${adminToken}`;
  let response;
  try {
    response = await fetch(`${runtimeBase}${pathname}`, {...options, headers, signal: AbortSignal.timeout(20000)});
  } catch (error) {
    fail(`runtime_unreachable ${runtimeBase}${pathname}: ${error.message}`);
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
    fail(`${pathname} HTTP ${response.status}: ${detail}`);
  }
  return body;
}

const health = await request('/health');
if (health?.ok !== true) fail(`runtime_health_not_ok: ${JSON.stringify(health).slice(0, 300)}`);

const list = await request('/v1/admin/applications');
const applications = Array.isArray(list?.applications) ? list.applications : (Array.isArray(list?.users) ? list.users : []);
let application = applications.find(item => item.name === appName) ?? null;
let apiKey = '';

if (!application) {
  if (dryRun) {
    console.log(`DRY_RUN would create application ${appName} and write ${keyFile}`);
  } else {
    const created = await request('/v1/admin/applications', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({name: appName, role: 'user'})
    });
    application = created?.application ?? null;
    apiKey = String(created?.apiKey ?? '');
  }
} else if (!dryRun) {
  if (application.status !== 'active') {
    await request(`/v1/admin/applications/${encodeURIComponent(application.id)}`, {
      method: 'PATCH',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({status: 'active'})
    });
  }
  const rotated = await request(`/v1/admin/applications/${encodeURIComponent(application.id)}/rotate-key`, {method: 'POST'});
  apiKey = String(rotated?.apiKey ?? '');
}

if (!dryRun) {
  if (!apiKey.startsWith('zc_')) fail('admin_api_did_not_return_an_application_key');
  await mkdir(path.dirname(keyFile), {recursive: true, mode: 0o700});
  const tempKey = `${keyFile}.tmp-${process.pid}`;
  await writeFile(tempKey, `${apiKey}\n`, {mode: 0o600});
  await rename(tempKey, keyFile);
  await chmod(keyFile, 0o600);
}

// `~/.config/opencode/opencode.json` is a symlink on this machine. Resolve it
// before reading and backing up, so the backup is of the real file and the edit
// lands where OpenCode actually reads.
let realConfigPath = configPath;
try { realConfigPath = await realpath(configPath); }
catch { /* the config may not exist yet; the path is still correct */ }
let config = {};
let existed = false;
try {
  const text = await readFile(realConfigPath, 'utf8');
  existed = true;
  try { config = text.trim() ? JSON.parse(text) : {}; }
  catch (error) { fail(`config_is_not_plain_json ${realConfigPath}: ${error.message}. Refusing to rewrite a JSONC file.`); }
} catch (error) {
  if (error?.code !== 'ENOENT') fail(`cannot_read_config ${realConfigPath}: ${error.message}`);
}
if (!config || typeof config !== 'object' || Array.isArray(config)) fail('config_root_must_be_a_json_object');

const existingProvider = config.providers?.[providerId] && typeof config.providers[providerId] === 'object' ? config.providers[providerId] : {};
const nextProvider = {
  ...existingProvider,
  name: 'ZombieCoder',
  package: '@opencode/ai/providers/openai-compatible',
  settings: {
    ...(existingProvider.settings ?? {}),
    baseURL,
    apiKey: `{file:${keyFile.startsWith(home) ? `~${keyFile.slice(home.length)}` : keyFile}}`
  },
  models: {
    ...(existingProvider.models ?? {}),
    [publicModel]: {
      name: 'ZombieCoder Code Guru',
      capabilities: {tools: true, input: ['text'], output: ['text']},
      limit: {context: 32768, output: 8192}
    }
  }
};

const nextConfig = {
  ...config,
  providers: {...(config.providers ?? {}), [providerId]: nextProvider}
};
const modelRef = `${providerId}/${publicModel}`;
if (setDefault) nextConfig.model = modelRef;

// The ZombieCoder plugin owns the global default when its model strategy is
// `free`: it rewrites the root model on setup. Writing `model` here is still
// the correct fallback, but reporting `default=yes` would be a lie while the
// plugin is active. Read the plugin config and report what will really happen.
async function defaultState() {
  if (!setDefault) return {state: 'no', detail: ''};
  let pluginPath = path.join(configDir, 'zombiecoder', 'config.json');
  try { pluginPath = await realpath(pluginPath); } catch { /* plugin not installed */ }
  try {
    const plugin = JSON.parse(await readFile(pluginPath, 'utf8'));
    if (String(plugin?.modelStrategy ?? '').toLowerCase() === 'free') {
      return {state: 'plugin-managed', detail: `modelStrategy=free in ${pluginPath}`};
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') return {state: 'unknown', detail: `${pluginPath}: ${error.message}`};
  }
  return {state: 'yes', detail: ''};
}

const defaultInfo = await defaultState();
const defaultNote = defaultInfo.state === 'plugin-managed'
  ? `OPENCODE_PROVIDER_NOTE the ZombieCoder plugin rewrites the global default; select the model explicitly: --model ${modelRef}`
  : '';

if (dryRun) {
  console.log(`DRY_RUN config=${realConfigPath} provider=${providerId} baseURL=${baseURL} model=${modelRef} keyFile=${keyFile} default=${defaultInfo.state}${defaultInfo.detail ? ` defaultDetail=${JSON.stringify(defaultInfo.detail)}` : ''}`);
  if (defaultNote) console.log(defaultNote);
  process.exit(0);
}

let backup = null;
if (existed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backup = `${realConfigPath}.bak.${stamp}-pre-zombie-provider`;
  await copyFile(realConfigPath, backup);
}
await mkdir(path.dirname(realConfigPath), {recursive: true});
const tempConfig = `${realConfigPath}.tmp-${process.pid}`;
await writeFile(tempConfig, `${JSON.stringify(nextConfig, null, 2)}\n`, {mode: 0o600});
await rename(tempConfig, realConfigPath);

const keyStat = await stat(keyFile);
console.log(`OPENCODE_PROVIDER_OK provider=${providerId} model=${modelRef} publicModel=${publicModel} runtime=${baseURL} application=${application?.id ?? 'dry-run'} keyFile=${keyFile} keyMode=${(keyStat.mode & 0o777).toString(8)} config=${realConfigPath} default=${defaultInfo.state}${backup ? ` backup=${backup}` : ''}`);
if (defaultNote) console.log(defaultNote);
