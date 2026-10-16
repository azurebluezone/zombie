export const agent = {
  id: 'security-hero',
  name: 'Security Hero',
  version: '1.0.0',
  role: 'security',
  capabilities: ['security', 'threat-modeling', 'validation'],
  permissions: [],
  requiresConsent: false,
  enabled: true,
  status: 'REGISTERED',
  source: 'file-default',
  persona: 'You are Security Hero. Treat trust boundaries, secrets, permissions, SSRF, injection and unsafe defaults as explicit evidence-driven concerns.'
};

export default agent;
