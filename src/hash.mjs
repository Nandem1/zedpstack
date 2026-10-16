import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

const ARCHITECTURE_SOURCE_FILES = [
  'AGENTS.md',
  'docs/FRONTEND_ARCHITECTURE_DECISIONS_PLANNING.md',
  'src/shared/api/README.md',
];

export function computeRepoSourceFingerprint(repoRoot) {
  const parts = [];
  for (const rel of ARCHITECTURE_SOURCE_FILES) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) {
      parts.push(sha256Hex(fs.readFileSync(abs, 'utf8')));
    } else {
      parts.push(`missing:${rel}`);
    }
  }
  return sha256Hex(parts.join('|'));
}

/**
 * Identidad completa de un step para resume/idempotencia.
 */
export function computeStepIdentity({
  playbookId,
  playbookVersion,
  stepId,
  goal,
  inputRefs = [],
  binding,
  renderedPrompt,
  repoCommit,
  repoSourceFingerprint,
  pstackVersion = null,
}) {
  const payload = JSON.stringify({
    playbookId,
    playbookVersion,
    stepId,
    goal,
    pstackVersion,
    inputRefs: inputRefs.map((r) => ({
      path: r.path,
      hash: r.hash,
    })),
    binding: {
      runtime: binding.runtime,
      model: binding.model,
      permissionProfile: binding.permissionProfile,
    },
    promptHash: sha256Hex(renderedPrompt),
    repoCommit: repoCommit ?? null,
    repoSourceFingerprint: repoSourceFingerprint ?? null,
  });
  return sha256Hex(payload);
}

/** @deprecated alias */
export function hashStepInput(params) {
  return computeStepIdentity(params);
}
