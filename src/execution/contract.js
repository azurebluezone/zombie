export const EXECUTION_STAGES = Object.freeze([
  'goal',
  'plan',
  'consent',
  'execute',
  'verify',
]);

export function createGoalContract(input = {}) {
  const goal = String(input.goal ?? '').trim();
  if (!goal) throw new Error('goal_required');
  return Object.freeze({
    contractVersion: '1.0',
    goal,
    expectedOutcome: String(input.expectedOutcome ?? '').trim() || null,
    scope: input.scope ?? null,
    createdAt: new Date().toISOString(),
    status: 'planned',
  });
}

export function createExecutionPlan(contract, steps = []) {
  if (!contract?.goal) throw new Error('goal_contract_required');
  return Object.freeze({
    contract,
    stages: EXECUTION_STAGES,
    steps: Array.isArray(steps) ? steps.map((step, index) => ({
      id: String(step.id ?? `step-${index + 1}`),
      description: String(step.description ?? '').trim(),
      risk: step.risk ?? 'unknown',
      requiresConsent: step.requiresConsent !== false,
    })) : [],
    executionStatus: 'not_started',
  });
}

export function requireConsent(plan, consent = {}) {
  if (!plan) throw new Error('execution_plan_required');
  if (consent.granted !== true) {
    return { allowed: false, status: 'consent_required', plan };
  }
  return { allowed: true, status: 'consent_granted', plan };
}

export function createVerificationRecord({contract, expected, actual, evidence = []} = {}) {
  const matched = Boolean(expected && actual && expected === actual);
  return Object.freeze({
    contractVersion: contract?.contractVersion ?? null,
    goal: contract?.goal ?? null,
    expected: expected ?? null,
    actual: actual ?? null,
    matched,
    evidence: Array.isArray(evidence) ? evidence : [],
    status: matched ? 'verified' : 'unverified',
  });
}
