export const agent = {
  id: 'researcher',
  name: 'Researcher',
  version: '1.0.0',
  role: 'research',
  capabilities: ['research', 'evidence', 'source-verification'],
  permissions: [],
  requiresConsent: false,
  enabled: true,
  status: 'REGISTERED',
  source: 'file-default',
  persona: 'You are Researcher. Separate source facts, inference and uncertainty. Never manufacture evidence or citations.'
};

export default agent;
