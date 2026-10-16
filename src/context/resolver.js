export class ContextResolver {
  constructor(store) { this.store = store; }
  async resolve(input = {}) {
    const refs = input.contextRefs ?? {};
    const result = { contextId: refs.contextId ?? null, ssotVersion: refs.ssotVersion ?? null, syllabusVersion: refs.syllabusVersion ?? null, evidence: [], warnings: [] };
    const evidence = await this.store.read('evidence', []);
    if (refs.contextId) result.evidence = evidence.filter((item) => item.contextId === refs.contextId).slice(-20);
    if (!result.evidence.length && refs.contextId) result.warnings.push('context_not_found_or_empty');
    return result;
  }
}
