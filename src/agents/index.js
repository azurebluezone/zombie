import codeGuru from './code-guru.js';
import bugHunter from './bug-hunter.js';
import securityHero from './security-hero.js';
import perfWizard from './perf-wizard.js';
import docKing from './doc-king.js';
import qaTyrant from './qa-tyrant.js';
import planner from './planner.js';
import researcher from './researcher.js';
import integrator from './integrator.js';
import customerExperienceSpecialist from './customer-experience-specialist.js';
import ecommerceOperationsAnalyst from './ecommerce-operations-analyst.js';
import teamHeart from './team-heart.js';

export const DEFAULT_AGENTS = [
  codeGuru, bugHunter, securityHero, perfWizard, docKing, qaTyrant,
  planner, researcher, integrator, customerExperienceSpecialist,
  ecommerceOperationsAnalyst, teamHeart
];

export const DEFAULT_AGENT_MAP = new Map(DEFAULT_AGENTS.map(agent => [agent.id, agent]));

export function getDefaultAgent(id) {
  return DEFAULT_AGENT_MAP.get(id) || null;
}

export {
  codeGuru, bugHunter, securityHero, perfWizard, docKing, qaTyrant,
  planner, researcher, integrator, customerExperienceSpecialist,
  ecommerceOperationsAnalyst, teamHeart
};
