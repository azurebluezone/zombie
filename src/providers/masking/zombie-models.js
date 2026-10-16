/** Public model aliases exposed to agents. They are routing profiles, not claims
 * that every upstream provider runs the same underlying model or quality tier. */
export const ZOMBIECODER_MODELS = Object.freeze([
  Object.freeze({ id: 'zombie-mini', name: 'ZombieMini', description: 'Default lightweight routing profile' }),
  Object.freeze({ id: 'zombie-lite', name: 'ZombieLite', description: 'Balanced routing profile' }),
  Object.freeze({ id: 'zombie-classic', name: 'ZombieClassic', description: 'General-purpose routing profile' })
]);

const aliases = new Map(ZOMBIECODER_MODELS.map(model => [model.id, model]));
export function resolveZombieModelAlias(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^zombiecoder\//, '');
  return aliases.get(normalized) ?? null;
}
