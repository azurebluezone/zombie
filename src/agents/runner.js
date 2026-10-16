export class AgentRunner {
  constructor({registry, personas, evidenceGate, logger=null}) { this.registry=registry; this.personas=personas; this.evidenceGate=evidenceGate; this.logger=logger; }
  async prepare({agentId='code-guru', personaId=agentId, goal, expectedOutcome=null, tools=[]}={}){
    if(!goal) throw new Error('agent_goal_required');
    const agent=await this.registry.resolve(agentId);
    const persona=await this.personas.resolve(personaId);
    const result={agent,persona,goal,expectedOutcome,requestedTools:Array.isArray(tools)?tools:[],status:'prepared'};
    await this.logger?.info?.('agent.prepared', {agentId:agent.id,agentName:agent.name,personaId:persona.id,personaName:persona.name,role:persona.role,expectedOutcomePresent:Boolean(expectedOutcome),requestedToolCount:result.requestedTools.length});
    return result;
  }
  verify(result){
    const evidence=Array.isArray(result?.evidence)?result.evidence:[];
    const verified=this.evidenceGate.canClaimSuccess(evidence);
    this.logger?.info?.('agent.verification', {verified,evidenceCount:evidence.length});
    return {verified,evidence};
  }
}
