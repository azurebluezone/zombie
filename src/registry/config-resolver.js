function normalizeId(value) {
  return String(value ?? '').trim().toLowerCase();
}

function envKey(id) {
  return `ZOMBIECODER_TOOL_${normalizeId(id).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()}`;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['1','true','yes','on','enabled'].includes(raw)) return true;
  if (['0','false','no','off','disabled'].includes(raw)) return false;
  return null;
}

function parseToolList(value) {
  return String(value ?? '').split(',').map(normalizeId).filter(Boolean);
}

export class CapabilityConfigResolver {
  constructor({store, envObject=process.env}={}) {
    this.store = store;
    this.env = envObject;
  }

  async application(applicationId) {
    const applications = await this.store.read('applications', []);
    return applications.find(item => item.id === applicationId) ?? null;
  }

  async toolSetting(applicationId, toolId) {
    const id = normalizeId(toolId);
    const app = await this.application(applicationId);
    const configured = app?.capabilities?.tools;
    if (configured && Object.prototype.hasOwnProperty.call(configured, id)) {
      const parsed = parseBoolean(configured[id]?.enabled ?? configured[id]);
      if (parsed !== null) return {enabled:parsed, source:'database', explicit:true};
    }

    const direct = parseBoolean(this.env[envKey(id)]);
    if (direct !== null) return {enabled:direct, source:'environment', explicit:true, envKey:envKey(id)};

    const allowList = parseToolList(this.env.ZOMBIECODER_TOOLS);
    if (allowList.length) return {enabled:allowList.includes(id), source:'environment-list', explicit:true, envKey:'ZOMBIECODER_TOOLS'};

    return {enabled:null, source:'unconfigured', explicit:false};
  }

  async setToolSetting(applicationId, toolId, enabled) {
    const id = normalizeId(toolId);
    if (!applicationId || !id) throw new Error('application_id_and_tool_required');
    const value = Boolean(enabled);
    const applications = await this.store.read('applications', []);
    const index = applications.findIndex(item => item.id === applicationId);
    if (index < 0) throw new Error('application_not_found');
    const current = applications[index];
    const capabilities = current.capabilities && typeof current.capabilities === 'object' ? structuredClone(current.capabilities) : {};
    const tools = capabilities.tools && typeof capabilities.tools === 'object' ? capabilities.tools : {};
    tools[id] = {enabled:value, updatedAt:new Date().toISOString()};
    capabilities.tools = tools;
    applications[index] = {...current, capabilities, updatedAt:new Date().toISOString()};
    await this.store.write('applications', applications);
    return {applicationId, toolId:id, enabled:value, source:'database'};
  }

  async snapshot(applicationId, toolIds=[]) {
    const ids = [...new Set(toolIds.map(normalizeId).filter(Boolean))];
    const result = {};
    for (const id of ids) result[id] = await this.toolSetting(applicationId, id);
    return result;
  }
}
