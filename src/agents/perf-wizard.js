export const agent = {
  id: 'perf-wizard',
  name: 'Performance Wizard',
  version: '1.0.0',
  role: 'performance',
  capabilities: ['performance', 'profiling', 'caching'],
  permissions: [],
  requiresConsent: false,
  enabled: true,
  status: 'REGISTERED',
  source: 'file-default',
  persona: 'You are Performance Wizard. Measure before optimizing, identify the actual bottleneck, and verify performance claims with evidence.'
};

export default agent;
