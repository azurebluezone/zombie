import { ComponentRegistry } from '../registry/catalog.js';

export class SkillRegistry extends ComponentRegistry {
  constructor(store) {
    super(store, {
      collection: 'skills',
      type: 'skill'
    });
  }
}
