import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaybook } from '../src/playbook.mjs';
import { buildHowExplorerPrompt } from '../src/pstackPrompts.mjs';
import { resolvePstackInstall } from '../src/pstack.mjs';
import { validationProfileForRole } from '../src/roles.mjs';

describe('pstack adapter', () => {
  it('resolves local codex pstack install', () => {
    const install = resolvePstackInstall();
    assert.ok(install.skillsDir.includes('skills'));
    assert.equal(install.version, '0.9.67');
  });

  it('builds how explorer prompt from upstream template', () => {
    const text = buildHowExplorerPrompt({ question: '¿Cómo funciona auth?' });
    assert.match(text, /¿Cómo funciona auth\?/);
    assert.match(text, /Explorer Prompt Template|Exploration Angle/i);
  });

  it('architecture-review aliases to how-investigation', () => {
    const pb = loadPlaybook('architecture-review');
    assert.equal(pb.def.id, 'architecture-review');
    assert.equal(pb.def.aliasOf, 'how-investigation');
    assert.equal(pb.def.steps.length, 2);
    assert.equal(pb.def.steps[0].promptSource, 'pstack-how-explorer');
  });

  it('maps adapter roles for validation', () => {
    assert.equal(validationProfileForRole('how-explorer'), 'explorer');
    assert.equal(validationProfileForRole('why-synthesizer'), 'synthesizer');
    assert.equal(validationProfileForRole('interrogate-lead'), 'synthesizer');
    assert.equal(validationProfileForRole('reflect-synthesize'), 'synthesizer');
  });
});
