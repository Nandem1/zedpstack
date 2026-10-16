const EXPLORER_PROFILE = new Set([
  'explorer',
  'how-explorer',
  'why-investigator',
  'architect-ground',
  'architect-runner',
  'interrogate-reviewer',
  'interrogate-reviewer-a',
  'interrogate-reviewer-b',
  'interrogate-reviewer-c',
  'reflect-reviewer',
  'reflect-reviewer-judgment',
  'reflect-reviewer-tooling',
  'reflect-reviewer-divergent',
  'architect-runner-a',
  'architect-runner-b',
]);

const SYNTHESIZER_PROFILE = new Set([
  'synthesizer',
  'how-explainer',
  'why-synthesizer',
  'architect-synthesize',
  'interrogate-lead',
  'reflect-synthesize',
]);

/**
 * Maps playbook role ids to validation profile (explorer vs synthesizer rules).
 */
export function validationProfileForRole(role) {
  if (EXPLORER_PROFILE.has(role)) {
    return 'explorer';
  }
  if (SYNTHESIZER_PROFILE.has(role)) {
    return 'synthesizer';
  }
  return role;
}
