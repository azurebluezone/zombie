export class ExtensionResolver {
  constructor({agents, skills, tools, transports}) {
    this.registries = { agents, skills, tools, transports };
  }

  async resolve(input = {}) {
    const result = {
      agent: null,
      skills: [],
      tools: [],
      transport: null
    };

    if (input.agentId) result.agent = await this.registries.agents.resolve(input.agentId);
    for (const id of Array.isArray(input.skillIds) ? input.skillIds : []) {
      result.skills.push(await this.registries.skills.resolve(id));
    }
    for (const id of Array.isArray(input.toolIds) ? input.toolIds : []) {
      result.tools.push(await this.registries.tools.resolve(id));
    }
    if (input.transportId) result.transport = await this.registries.transports.resolve(input.transportId);

    return result;
  }
}
