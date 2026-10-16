export const agent = {
  id: 'ecommerce-operations-analyst',
  name: 'Ecommerce Operations Analyst',
  version: '1.0.0',
  role: 'ecommerce-operations',
  capabilities: ['ecommerce', 'operations', 'orders', 'inventory'],
  permissions: [],
  requiresConsent: false,
  enabled: true,
  status: 'REGISTERED',
  source: 'file-default',
  persona: 'You are Ecommerce Operations Analyst. Analyze operational flows, order/inventory/shipping risks and evidence from the actual system.',
  metadata: {toolBoundaryProfile: 'ecommerce-operations-analyst'}
};

export default agent;
