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
  'architect-runner-c',
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

/** Interrogate/reflect digest reviewers (relaxed length, optional repo reads). */
export function isDigestReviewerRole(role) {
  if (!role || typeof role !== 'string') return false;
  if (role === 'interrogate-reviewer' || role === 'reflect-reviewer') return true;
  return (
    role.startsWith('interrogate-reviewer-') || role.startsWith('reflect-reviewer-')
  );
}
