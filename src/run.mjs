import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, resolveRoleBinding, resolveTimeout } from './config.mjs';
import { EventSink } from './events/sink.mjs';
import { tryGitCommit } from './git.mjs';
import {
  computeRepoSourceFingerprint,
  computeStepIdentity,
  sha256Hex,
} from './hash.mjs';
import {
  JUDGMENT_INSTRUCTIONS_FILE,
  ORCHESTRATOR_JUDGMENT_FILE,
  validateOrchestratorJudgment,
} from './judgment.mjs';
import {
  createInitialManifest,
  readManifest,
  updateManifestStep,
  writeManifestAtomic,
} from './manifest.mjs';
import { withManifestLock } from './manifestLock.mjs';
import {
  attachPstackUpstreamMeta,
  loadPlaybook,
  loadPrompt,
  loadStepPrompt,
} from './playbook.mjs';
import { resolvePstackInstall } from './pstack.mjs';
import { validationProfileForRole } from './roles.mjs';
import { runDir, workerDir, zedpstackRoot } from './paths.mjs';
import {
  canReuseCompletedStep,
  resultPathForStep,
  stdoutLogForStep,
} from './resume.mjs';
import { runWorkerForBinding } from './runtimes/index.mjs';
import { validateWorkerResult } from './validation.mjs';

function initStepRecords(playbookDef, config) {
  return playbookDef.steps.map((step) => {
    const binding = resolveRoleBinding(config, step.role);
    return {
      stepId: step.id,
      role: step.role,
      status: 'pending',
      stepIdentityHash: null,
      binding,
      attempts: [],
    };
  });
}

function findStepDef(playbookDef, stepId) {
  const s = playbookDef.steps.find((x) => x.id === stepId);
  if (!s) throw new Error(`Unknown step ${stepId}`);
  return s;
}

function buildInputRefs(runRoot, stepDef, playbookDef) {
  const inputRefs = [];
  if (!stepDef.inputFrom?.length) return inputRefs;

  for (const fromId of stepDef.inputFrom) {
    const prevResult = resultPathForStep(runRoot, fromId);
    if (!fs.existsSync(prevResult)) {
      throw new Error(`Upstream step ${fromId} result missing for ${stepDef.id}`);
    }
    const raw = fs.readFileSync(prevResult, 'utf8');
    const parsed = JSON.parse(raw);
    const upstreamStep = playbookDef.steps.find((s) => s.id === fromId);
    const upstreamRole = upstreamStep
      ? validationProfileForRole(upstreamStep.role)
      : null;
    const upstreamValidation = validateWorkerResult({
      exitCode: parsed.exitCode ?? 0,
      resultPath: prevResult,
      outputContract: 'markdown-report',
      processExited: true,
      role: upstreamStep?.role ?? null,
      validationProfile: upstreamRole,
      stdoutLogPath: stdoutLogForStep(runRoot, fromId),
    });
    if (!upstreamValidation.valid) {
      throw new Error(
        `Upstream step ${fromId} invalid: ${upstreamValidation.errors.join('; ')}`,
      );
    }
    inputRefs.push({ path: prevResult, hash: sha256Hex(raw) });
  }
  return inputRefs;
}

function loadPriorTexts(runRoot, stepDef) {
  const priorTexts = {};
  for (const fromId of stepDef.inputFrom ?? []) {
    const p = resultPathForStep(runRoot, fromId);
    priorTexts[fromId] = JSON.parse(fs.readFileSync(p, 'utf8')).text;
  }
  return priorTexts;
}

function preparePromptText({ stepDef, playbook, runRoot, repoRoot, goal, context }) {
  const priorTexts = stepDef.inputFrom?.length ? loadPriorTexts(runRoot, stepDef) : {};
  return loadStepPrompt({
    playbook,
    stepDef,
    goal,
    repoRoot,
    context,
    priorTexts,
  });
}

async function updateManifestLocked(runId, runRoot, updater) {
  return withManifestLock(runId, () => {
    const current = readManifest(runRoot);
    const next = updater(current);
    writeManifestAtomic(runRoot, next);
    return next;
  });
}

/** Pasos pending cuyos inputFrom están todos completed (orden del playbook). */
export function computeReadyStepIds(manifest, playbookDef) {
  const completedIds = new Set(
    manifest.steps
      .filter((s) => s.status === 'completed')
      .map((s) => s.stepId),
  );
  const ready = [];
  for (const stepDef of playbookDef.steps) {
    const rec = manifest.steps.find((s) => s.stepId === stepDef.id);
    if (!rec || rec.status !== 'pending') continue;
    const deps = stepDef.inputFrom ?? [];
    if (deps.every((id) => completedIds.has(id))) {
      ready.push(stepDef.id);
    }
  }
  return ready;
}

/**
 * Failed steps retry on resume. A step left `running` belongs to a dispatcher
 * that died (crash, kill, missing CLI) because only one dispatcher drives a run.
 */
function resetFailedStepsToPending(manifest, playbookDef, { includeRunning = false } = {}) {
  let next = manifest;
  let changed = false;
  for (const step of playbookDef.steps) {
    const rec = next.steps.find((s) => s.stepId === step.id);
    if (rec?.status === 'failed' || (includeRunning && rec?.status === 'running')) {
      next = updateManifestStep(next, step.id, { status: 'pending' });
      if (next.status !== 'running') {
        next = { ...next, status: 'running' };
      }
      changed = true;
    }
  }
  return { manifest: next, changed };
}

function loadRunContext(runRoot) {
  const p = path.join(runRoot, 'context-input.md');
  if (!fs.existsSync(p)) {
    return '';
  }
  return fs.readFileSync(p, 'utf8');
}

async function executeStep({
  playbook,
  playbookDef,
  config,
  runRoot,
  repoRoot,
  goal,
  stepId,
  eventSink,
  runId,
}) {
  const context = loadRunContext(runRoot);
  let manifest = await withManifestLock(runId, () => readManifest(runRoot));
  if (manifest.status === 'cancelled') {
    return manifest;
  }

  const stepRecord = manifest.steps.find((s) => s.stepId === stepId);
  const stepDef = findStepDef(playbookDef, stepId);
  const binding = resolveRoleBinding(config, stepDef.role);
  const inputRefs = buildInputRefs(runRoot, stepDef, playbookDef);
  const promptText = preparePromptText({
    stepDef,
    playbook,
    runRoot,
    repoRoot,
    goal,
    context,
  });

  const repoCommit = tryGitCommit(repoRoot);
  const repoSourceFingerprint = computeRepoSourceFingerprint(repoRoot);
  const stepIdentityHash = computeStepIdentity({
    playbookId: playbookDef.id,
    playbookVersion: playbookDef.version,
    stepId,
    goal,
    inputRefs,
    binding,
    renderedPrompt: promptText,
    repoCommit,
    repoSourceFingerprint,
    pstackVersion: playbookDef.upstream?.pstackVersion ?? null,
  });

  const resultPath = resultPathForStep(runRoot, stepId);
  const stdoutLog = stdoutLogForStep(runRoot, stepId);

  const reuse = canReuseCompletedStep({
    stepRecord,
    stepIdentityHash,
    resultPath,
    outputContract: stepDef.outputContract,
    role: stepDef.role,
    validationProfile: validationProfileForRole(stepDef.role),
    stdoutLogPath: stdoutLog,
  });

  if (reuse.reuse) {
    eventSink.emit('step.completed', { runId, stepId, resumed: true, reuse: true });
    return updateManifestLocked(runId, runRoot, (current) =>
      updateManifestStep(current, stepId, {
        stepIdentityHash,
        lastErrors: null,
      }),
    );
  }

  if (
    reuse.reason === 'result_invalid' ||
    reuse.reason === 'result_missing' ||
    reuse.reason === 'identity_mismatch'
  ) {
    manifest = await updateManifestLocked(runId, runRoot, (current) =>
      updateManifestStep(current, stepId, {
        status: 'pending',
        validResult: false,
      }),
    );
  }

  eventSink.emit('step.started', { runId, stepId, stepIdentityHash });

  const taskSpec = {
    goal,
    inputRefs,
    outputContract: stepDef.outputContract,
    timeout: resolveTimeout(config, stepDef.role),
  };

  const wRoot = workerDir(runRoot, stepId);
  const workerId = `${stepId}-${Date.now()}`;
  const attempt = {
    workerId,
    startedAt: new Date().toISOString(),
    binding,
    taskSpec,
    stepIdentityHash,
  };

  await updateManifestLocked(runId, runRoot, (current) => {
    const rec = current.steps.find((s) => s.stepId === stepId);
    return updateManifestStep(current, stepId, {
      status: 'running',
      stepIdentityHash,
      attempts: [...rec.attempts, attempt],
    });
  });

  const patchAttemptPid = (pid) => {
    void updateManifestLocked(runId, runRoot, (current) => {
      const stepNow = current.steps.find((s) => s.stepId === stepId);
      const attemptsWithPid = [...stepNow.attempts];
      const lastIdx = attemptsWithPid.length - 1;
      if (lastIdx >= 0) {
        attemptsWithPid[lastIdx] = { ...attemptsWithPid[lastIdx], pid };
      }
      return updateManifestStep(current, stepId, {
        attempts: attemptsWithPid,
      });
    });
  };

  let outcome;
  try {
    outcome = await runWorkerForBinding({
    binding,
    taskSpec,
    workerRoot: wRoot,
    repoRoot: path.resolve(repoRoot),
    promptText,
    eventSink,
    workerId,
    runId,
    stepId,
    role: stepDef.role,
    onWorkerSpawned: ({ pid }) => patchAttemptPid(pid),
    });
  } catch (err) {
    const message = `worker_error: ${err.message}`;
    eventSink.emit('step.failed', { runId, stepId, workerId, errors: [message] });
    return updateManifestLocked(runId, runRoot, (current) => {
      const rec = current.steps.find((s) => s.stepId === stepId);
      const attempts = [...rec.attempts];
      attempts[attempts.length - 1] = {
        ...attempts[attempts.length - 1],
        finishedAt: new Date().toISOString(),
        error: message,
      };
      const failed = updateManifestStep(current, stepId, {
        status: 'failed',
        validResult: false,
        lastErrors: [message],
        attempts,
      });
      return { ...failed, status: failed.status === 'cancelled' ? 'cancelled' : 'failed' };
    });
  }

  manifest = await withManifestLock(runId, () => readManifest(runRoot));
  if (manifest.status === 'cancelled') {
    return manifest;
  }

  const validation = validateWorkerResult({
    exitCode: outcome.exitCode,
    resultPath: outcome.resultPath,
    outputContract: stepDef.outputContract,
    processExited: outcome.processExited,
    role: stepDef.role,
    validationProfile: validationProfileForRole(stepDef.role),
    stdoutLogPath: stdoutLog,
  });

  attempt.finishedAt = new Date().toISOString();
  attempt.exitCode = outcome.exitCode;
  attempt.validation = validation;
  attempt.cliVersion = outcome.cliVersion;

  return updateManifestLocked(runId, runRoot, (current) => {
    const stepWithFinishedAttempt = current.steps.find((s) => s.stepId === stepId);
    const attempts = [...stepWithFinishedAttempt.attempts];
    attempts[attempts.length - 1] = {
      ...attempts[attempts.length - 1],
      ...attempt,
    };

    if (validation.valid) {
      eventSink.emit('step.validated', { runId, stepId, workerId, stages: validation.stages });
      const next = updateManifestStep(current, stepId, {
        status: 'completed',
        stepIdentityHash,
        validResult: true,
        resultRef: path.relative(repoRoot, outcome.resultPath),
        attempts,
        lastErrors: null,
      });
      eventSink.emit('step.completed', { runId, stepId, workerId });
      return next;
    }

    eventSink.emit('run.failed', { runId, stepId, errors: validation.errors });
    const failed = updateManifestStep(current, stepId, {
      status: 'failed',
      validResult: false,
      lastErrors: validation.errors,
      attempts,
    });
    failed.status = 'failed';
    return failed;
  });
}

function writeJudgmentInstructionsIfNeeded(runRoot, playbook, playbookDef, manifest, runId) {
  const instructionsPath = path.join(runRoot, JUDGMENT_INSTRUCTIONS_FILE);
  if (fs.existsSync(instructionsPath)) {
    return;
  }
  const judgmentTemplate = loadPrompt(
    playbook.root,
    playbookDef.judgment.promptTemplate,
    {
      GOAL: manifest.goal,
      REPO_ROOT: manifest.repoRoot,
      RUN_ID: runId,
      ZEDPSTACK_ROOT: zedpstackRoot(),
      JUDGMENT_OUTPUT_FILE: ORCHESTRATOR_JUDGMENT_FILE,
    },
  );
  fs.writeFileSync(instructionsPath, judgmentTemplate, 'utf8');
}

export async function runPlaybook({
  playbookId,
  goal,
  repoRoot,
  runId: existingRunId,
  teeEvents = false,
  persistStreamEvents = false,
  context = '',
}) {
  const config = loadConfig();
  const playbook = loadPlaybook(playbookId);
  const playbookDef = attachPstackUpstreamMeta(playbook.def);
  if (playbookDef.upstream?.pstackSkill) {
    resolvePstackInstall();
  }

  const runId = existingRunId ?? randomUUID();
  const runRoot = runDir(repoRoot, runId);
  fs.mkdirSync(runRoot, { recursive: true });
  if (context) {
    fs.writeFileSync(path.join(runRoot, 'context-input.md'), context, 'utf8');
  }

  const eventSink = new EventSink(runRoot, {
    tee: teeEvents,
    persistWorkerStream: persistStreamEvents,
    humanProgress: 'auto',
  });
  let manifest;

  if (existingRunId && fs.existsSync(path.join(runRoot, 'manifest.json'))) {
    manifest = readManifest(runRoot);
    if (manifest.status === 'completed') {
      eventSink.emit('run.started', { runId, resumed: true, skipped: 'already_completed' });
      return { runId, runRoot, manifest, eventSink };
    }
    if (manifest.status === 'failed' || manifest.status === 'cancelled') {
      manifest.status = 'running';
      manifest.updatedAt = new Date().toISOString();
      writeManifestAtomic(runRoot, manifest);
    }
    eventSink.emit('run.started', { runId, resumed: true, playbook: playbookId });
  } else {
    const bindings = {};
    for (const step of playbookDef.steps) {
      bindings[step.role] = resolveRoleBinding(config, step.role);
    }
    manifest = createInitialManifest({
      runId,
      repoRoot: path.resolve(repoRoot),
      gitCommit: tryGitCommit(repoRoot),
      playbook: playbookId,
      goal,
      bindings,
      steps: initStepRecords(playbookDef, config),
    });
    writeManifestAtomic(runRoot, manifest);
    eventSink.emit('run.started', { runId, playbook: playbookId, goal });
  }

  let firstPass = true;
  while (true) {
    manifest = await withManifestLock(runId, () => readManifest(runRoot));
    if (manifest.status === 'failed' || manifest.status === 'cancelled') {
      break;
    }

    const { manifest: afterReset, changed } = resetFailedStepsToPending(manifest, playbookDef, {
      includeRunning: firstPass,
    });
    firstPass = false;
    if (changed) {
      manifest = await updateManifestLocked(runId, runRoot, () => afterReset);
    }

    const readyIds = computeReadyStepIds(manifest, playbookDef);
    if (readyIds.length === 0) {
      break;
    }

    eventSink.emit('step.wave.started', { runId, stepIds: readyIds });

    const settled = await Promise.allSettled(
      readyIds.map((stepId) =>
        executeStep({
          playbook,
          playbookDef,
          config,
          runRoot,
          repoRoot: path.resolve(repoRoot),
          goal: manifest.goal ?? goal,
          stepId,
          eventSink,
          runId,
        }),
      ),
    );
    const rejected = settled.find((r) => r.status === 'rejected');
    if (rejected) {
      throw rejected.reason;
    }

    manifest = await withManifestLock(runId, () => readManifest(runRoot));
    if (manifest.status === 'failed') {
      return { runId, runRoot, manifest, eventSink };
    }
  }

  const incomplete = manifest.steps.filter((st) => st.status !== 'completed');
  if (manifest.status === 'running' && incomplete.length) {
    const errors = incomplete.map((st) => `step ${st.stepId} is ${st.status}`);
    manifest = await updateManifestLocked(runId, runRoot, (current) => ({
      ...current,
      status: 'failed',
      updatedAt: new Date().toISOString(),
    }));
    eventSink.emit('run.failed', { runId, errors });
    return { runId, runRoot, manifest, eventSink };
  }

  if (manifest.status !== 'failed' && manifest.status !== 'completed' && manifest.status !== 'cancelled') {
    writeJudgmentInstructionsIfNeeded(runRoot, playbook, playbookDef, manifest, runId);
    manifest.status = 'awaiting_judgment';
    manifest.updatedAt = new Date().toISOString();
    writeManifestAtomic(runRoot, manifest);
    eventSink.emit('run.awaiting_judgment', { runId });
  }

  return { runId, runRoot, manifest, eventSink };
}

export function completeJudgment({ repoRoot, runId }) {
  const runRoot = runDir(repoRoot, runId);
  const instructionsPath = path.join(runRoot, JUDGMENT_INSTRUCTIONS_FILE);
  const judgmentPath = path.join(runRoot, ORCHESTRATOR_JUDGMENT_FILE);

  const judgmentCheck = validateOrchestratorJudgment({
    instructionsPath,
    judgmentPath,
  });
  if (!judgmentCheck.valid) {
    throw new Error(`Invalid judgment: ${judgmentCheck.errors.join('; ')}`);
  }

  const manifest = readManifest(runRoot);
  if (manifest.status !== 'awaiting_judgment') {
    throw new Error(`Run status is ${manifest.status}, expected awaiting_judgment`);
  }
  manifest.status = 'completed';
  manifest.judgmentRef = ORCHESTRATOR_JUDGMENT_FILE;
  manifest.updatedAt = new Date().toISOString();
  writeManifestAtomic(runRoot, manifest);
  const eventSink = new EventSink(runRoot);
  eventSink.emit('run.completed', { runId });
  return manifest;
}
