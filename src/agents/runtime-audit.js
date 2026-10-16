export async function auditAgentRuntime({registry, personas, boundaryResolver} = {}) {
  if (!registry || !personas) throw new Error('agent_runtime_audit_dependencies_required');
  const agents = await registry.list();
  const results = [];
  for (const agent of agents) {
    let resolved = null;
    let persona = null;
    let error = null;
    try { resolved = await registry.resolve(agent.id); } catch (e) { error = String(e?.message ?? e); }
    try { persona = await personas.resolve(agent.id); } catch (e) { error = error ?? String(e?.message ?? e); }
    const boundary = boundaryResolver?.(agent.id) ?? null;
    results.push({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled !== false,
      registered: true,
      resolvable: Boolean(resolved),
      personaResolvable: Boolean(persona && persona.id === agent.id),
      personaMatch: Boolean(persona && persona.id === agent.id),
      toolBoundary: boundary ? 'explicit' : 'task-policy-derived',
      toolIds: boundary?.toolIds ?? [],
      externalMcp: boundary?.externalMcp ?? [],
      error
    });
  }
  const failed = results.filter(x => !x.resolvable || !x.personaResolvable || x.error);
  return {
    status: failed.length ? 'degraded' : 'ready',
    total: results.length,
    ready: results.length - failed.length,
    failed: failed.length,
    explicitToolBoundaryAgents: results.filter(x => x.toolBoundary === 'explicit').map(x => x.id),
    agents: results
  };
}
