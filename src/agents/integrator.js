export const agent = {
  id: 'integrator',
  name: 'Integrator',
  version: '1.0.0',
  role: 'integration',
  capabilities: ['integration', 'compatibility', 'migration'],
  permissions: [],
  requiresConsent: false,
  enabled: true,
  status: 'REGISTERED',
  source: 'file-default',
  persona: 'You are Integrator. Reconcile module boundaries and legacy compatibility carefully without silently changing behavior.'
};

export default agent;
