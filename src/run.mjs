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
import { loadPlaybook, loadPrompt } from './playbook.mjs';
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

function buildInputRefs(runRoot, stepDef) {
  const inputRefs = [];
  if (!stepDef.inputFrom?.length) return inputRefs;

  for (const fromId of stepDef.inputFrom) {
    const prevResult = resultPathForStep(runRoot, fromId);
    if (!fs.existsSync(prevResult)) {
      throw new Error(`Upstream step ${fromId} result missing for ${stepDef.id}`);
    }
    const raw = fs.readFileSync(prevResult, 'utf8');
    const parsed = JSON.parse(raw);
    const upstreamRole = fromId === 'explore' ? 'explorer' : null;
    const upstreamValidation = validateWorkerResult({
      exitCode: parsed.exitCode ?? 0,
      resultPath: prevResult,
      outputContract: 'markdown-report',
      processExited: true,
      role: upstreamRole,
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

function preparePromptText({ stepId, stepDef, playbook, runRoot, repoRoot, goal }) {
  const vars = { GOAL: goal, REPO_ROOT: repoRoot };
  if (stepId === 'synthesize') {
    const exploreResult = resultPathForStep(runRoot, 'explore');
    const explore = JSON.parse(fs.readFileSync(exploreResult, 'utf8'));
    vars.EXPLORE_TEXT = explore.text;
  }
  return loadPrompt(playbook.root, stepDef.promptTemplate, vars);
}

function manifestWasCancelled(runRoot) {
  if (!fs.existsSync(path.join(runRoot, 'manifest.json'))) {
    return false;
  }
  return readManifest(runRoot).status === 'cancelled';
}

async function executeStep({
  manifest,
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
  if (manifestWasCancelled(runRoot)) {
    return readManifest(runRoot);
  }

  const stepRecord = manifest.steps.find((s) => s.stepId === stepId);
  const stepDef = findStepDef(playbookDef, stepId);
  const binding = resolveRoleBinding(config, stepDef.role);
  const inputRefs = buildInputRefs(runRoot, stepDef);
  const promptText = preparePromptText({
    stepId,
    stepDef,
    playbook,
    runRoot,
    repoRoot,
    goal,
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
  });

  const resultPath = resultPathForStep(runRoot, stepId);
  const stdoutLog = stdoutLogForStep(runRoot, stepId);

  const reuse = canReuseCompletedStep({
    stepRecord,
    stepIdentityHash,
    resultPath,
    outputContract: stepDef.outputContract,
    role: stepDef.role,
    stdoutLogPath: stdoutLog,
  });

  if (reuse.reuse) {
    eventSink.emit('step.completed', { runId, stepId, resumed: true, reuse: true });
    const updated = updateManifestStep(manifest, stepId, {
      stepIdentityHash,
      lastErrors: null,
    });
    writeManifestAtomic(runRoot, updated);
    return updated;
  }

  if (
    reuse.reason === 'result_invalid' ||
    reuse.reason === 'result_missing' ||
    reuse.reason === 'identity_mismatch'
  ) {
    manifest = updateManifestStep(manifest, stepId, {
      status: 'pending',
      validResult: false,
    });
    writeManifestAtomic(runRoot, manifest);
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

  let manifestPatched = updateManifestStep(manifest, stepId, {
    status: 'running',
    stepIdentityHash,
    attempts: [...stepRecord.attempts, attempt],
  });
  writeManifestAtomic(runRoot, manifestPatched);

  const patchAttemptPid = (pid) => {
    const stepNow = manifestPatched.steps.find((s) => s.stepId === stepId);
    const attemptsWithPid = [...stepNow.attempts];
    const lastIdx = attemptsWithPid.length - 1;
    if (lastIdx >= 0) {
      attemptsWithPid[lastIdx] = { ...attemptsWithPid[lastIdx], pid };
    }
    manifestPatched = updateManifestStep(manifestPatched, stepId, {
      attempts: attemptsWithPid,
    });
    writeManifestAtomic(runRoot, manifestPatched);
  };

  const outcome = await runWorkerForBinding({
    binding,
    taskSpec,
    workerRoot: wRoot,
    repoRoot: path.resolve(repoRoot),
    promptText,
    eventSink,
    workerId,
    runId,
    stepId,
    onWorkerSpawned: ({ pid }) => patchAttemptPid(pid),
  });

  if (manifestWasCancelled(runRoot)) {
    return readManifest(runRoot);
  }

  const validation = validateWorkerResult({
    exitCode: outcome.exitCode,
    resultPath: outcome.resultPath,
    outputContract: stepDef.outputContract,
    processExited: outcome.processExited,
    role: stepDef.role,
    stdoutLogPath: stdoutLog,
  });

  attempt.finishedAt = new Date().toISOString();
  attempt.exitCode = outcome.exitCode;
  attempt.validation = validation;
  attempt.cliVersion = outcome.cliVersion;

  const stepWithFinishedAttempt = manifestPatched.steps.find((s) => s.stepId === stepId);
  const attempts = [...stepWithFinishedAttempt.attempts];
  attempts[attempts.length - 1] = {
    ...attempts[attempts.length - 1],
    ...attempt,
  };

  if (validation.valid) {
    eventSink.emit('step.validated', { runId, stepId, workerId, stages: validation.stages });
    manifestPatched = updateManifestStep(manifestPatched, stepId, {
      status: 'completed',
      stepIdentityHash,
      validResult: true,
      resultRef: path.relative(repoRoot, outcome.resultPath),
      attempts,
      lastErrors: null,
    });
    eventSink.emit('step.completed', { runId, stepId, workerId });
  } else {
    manifestPatched = updateManifestStep(manifestPatched, stepId, {
      status: 'failed',
      validResult: false,
      lastErrors: validation.errors,
      attempts,
    });
    eventSink.emit('run.failed', { runId, stepId, errors: validation.errors });
    manifestPatched.status = 'failed';
  }

  writeManifestAtomic(runRoot, manifestPatched);
  return manifestPatched;
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
}) {
  const config = loadConfig();
  const playbook = loadPlaybook(playbookId);
  const playbookDef = playbook.def;

  const runId = existingRunId ?? randomUUID();
  const runRoot = runDir(repoRoot, runId);
  fs.mkdirSync(runRoot, { recursive: true });

  const eventSink = new EventSink(runRoot, {
    tee: teeEvents,
    persistWorkerStream: persistStreamEvents,
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

  // Siempre pasar por executeStep: revalida identidad, artefactos y resultado
  // (evita el bypass de allStepsDone en resume).
  for (const step of playbookDef.steps) {
    manifest = readManifest(runRoot);
    if (manifest.status === 'failed' || manifest.status === 'cancelled') {
      break;
    }
    const rec = manifest.steps.find((s) => s.stepId === step.id);
    if (rec.status === 'failed') {
      manifest = updateManifestStep(manifest, step.id, { status: 'pending' });
      manifest.status = 'running';
      writeManifestAtomic(runRoot, manifest);
    }

    manifest = await executeStep({
      manifest,
      playbook,
      playbookDef,
      config,
      runRoot,
      repoRoot: path.resolve(repoRoot),
      goal: manifest.goal ?? goal,
      stepId: step.id,
      eventSink,
      runId,
    });
    if (manifest.status === 'failed') {
      return { runId, runRoot, manifest, eventSink };
    }
  }

  if (manifest.status !== 'failed' && manifest.status !== 'completed') {
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
