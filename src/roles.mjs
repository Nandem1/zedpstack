/**
 * Maps playbook role ids to validation profile (explorer vs synthesizer rules).
 */
export function validationProfileForRole(role) {
  if (role === 'how-explorer' || role === 'explorer') {
    return 'explorer';
  }
  if (role === 'how-explainer' || role === 'synthesizer') {
    return 'synthesizer';
  }
  return role;
}
