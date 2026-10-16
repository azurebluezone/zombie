import { createGoalContract, createExecutionPlan, requireConsent } from './contract.js';

export class ExecutionOrchestrator {
  constructor({executor = null, extensionResolver = null} = {}) { this.executor = executor; this.extensionResolver = extensionResolver; }

  async prepare(input = {}) {
    const contract = createGoalContract(input);
    const plan = createExecutionPlan(contract, input.steps ?? []);
    const consent = requireConsent(plan, {granted: input.consent === true});
    const extensions = this.extensionResolver ? await this.extensionResolver.resolve(input) : null;
    return { contract, plan, consent, extensions, execution: { status: 'not_started' } };
  }

  async execute(prepared, input = {}, applicationId = null, context = null) {
    if (!this.executor) throw new Error('execution_adapter_not_connected');
    return this.executor.execute({prepared, input, applicationId, context});
  }
}
