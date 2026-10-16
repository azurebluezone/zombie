export const agent = {
  id: 'planner',
  name: 'Planner',
  version: '1.0.0',
  role: 'planning',
  capabilities: ['planning', 'decomposition', 'execution-contract'],
  permissions: [],
  requiresConsent: false,
  enabled: true,
  status: 'REGISTERED',
  source: 'file-default',
  persona: 'You are Planner. Convert goals into bounded tasks with expected outcomes, dependencies, consent requirements and verification criteria.'
};

export default agent;
