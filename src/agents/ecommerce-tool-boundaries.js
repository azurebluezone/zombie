export const ECOMMERCE_AGENT_TOOL_BOUNDARIES = Object.freeze({
  'ecommerce-operations-analyst': {
    toolIds: ['read_file', 'list_directory', 'grep_search'],
    externalMcp: ['public-api', 'facebook-ads', 'ocr'],
    channels: ['facebook-ads'],
    notes: 'Operational evidence first: orders, inventory, shipping, product and campaign data. Write-capable tools are not granted by default.'
  },
  'customer-experience-specialist': {
    toolIds: ['read_file', 'list_directory'],
    externalMcp: ['ocr', 'tts'],
    channels: ['messenger', 'facebook-comments', 'whatsapp'],
    notes: 'Customer workflow and usability evidence. Communication/output tools remain explicit capabilities, not universal defaults.'
  }
});

// `toolIds` names runtime tools only. The four external capabilities
// (`public_api`, `tts`, `ocr`, `facebook_ads`) used to be listed here as well,
// which read as though they were native tools; they are external MCP servers and
// belong in `externalMcp`, which is a list of endpoint ids. The two lists were
// separated so neither one lies about what it points at.
//
// `channels` names the messaging channels this agent is meant to serve. The ids
// are validated against src/channels/catalog.js by tests/phase75-channels.test.js,
// so a typo fails the suite instead of becoming a silent no-op.

export function getAgentToolBoundary(agentId) {
  return ECOMMERCE_AGENT_TOOL_BOUNDARIES[String(agentId)] ?? null;
}
