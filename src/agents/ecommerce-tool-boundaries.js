export const ECOMMERCE_AGENT_TOOL_BOUNDARIES = Object.freeze({
  'ecommerce-operations-analyst': {
    toolIds: ['read_file', 'list_directory', 'public_api', 'facebook_ads', 'ocr'],
    externalMcp: ['public-api', 'facebook-ads', 'ocr'],
    notes: 'Operational evidence first: orders, inventory, shipping, product and campaign data. Write-capable tools are not granted by default.'
  },
  'customer-experience-specialist': {
    toolIds: ['read_file', 'list_directory', 'ocr', 'tts'],
    externalMcp: ['ocr', 'tts'],
    notes: 'Customer workflow and usability evidence. Communication/output tools remain explicit capabilities, not universal defaults.'
  }
});

export function getAgentToolBoundary(agentId) {
  return ECOMMERCE_AGENT_TOOL_BOUNDARIES[String(agentId)] ?? null;
}
