import { validationProfileForRole } from './roles.mjs';

const RUNTIME_LABEL = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

function profileLabel(role) {
  const profile = validationProfileForRole(role ?? '');
  if (profile === 'explorer') return 'explorer';
  if (profile === 'synthesizer') return 'synthesizer';
  return role ?? 'worker';
}

function toolActivityLine(toolName, input) {
  const name = toolName ?? '';
  const inp = input ?? {};
  if (name === 'Read' && inp.file_path) {
    return `> Inspecting ${shortPath(inp.file_path)}`;
  }
  if (name === 'Grep' && inp.pattern) {
    return `> Searching for "${String(inp.pattern).slice(0, 60)}"`;
  }
  if (name === 'Glob' && inp.pattern) {
    return `> Listing ${inp.pattern}`;
  }
  if (name === 'Edit' || name === 'Write') {
    const p = inp.file_path ?? inp.path ?? '';
    return `> Editing ${shortPath(p)}`;
  }
  if (name === 'Bash' && inp.command) {
    return `> Running ${String(inp.command).slice(0, 72)}`;
  }
  return `> ${name}`;
}

function shortPath(p) {
  const s = String(p);
  const idx = s.indexOf('/src/');
  return idx >= 0 ? s.slice(idx + 1) : s.split('/').slice(-2).join('/');
}

/**
 * Parse one stream-json line (Claude / Cursor agent) into a human activity line.
 * @returns {string | null}
 */
export function activityFromStreamJsonLine(line) {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_use') {
          return toolActivityLine(block.name, block.input);
        }
      }
    }
    if (obj.type === 'stream_event' && obj.event?.type === 'content_block_start') {
      const block = obj.event.content_block;
      if (block?.type === 'tool_use') {
        return toolActivityLine(block.name, block.input);
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} event
 * @param {{ useColor?: boolean }} opts
 */
export function formatHumanProgressEvent(event, opts = {}) {
  const { type, stepId, workerId, runtime, model, role, chunk, status, errors } = event;
  const rt = RUNTIME_LABEL[runtime] ?? runtime ?? 'Worker';
  const prof = profileLabel(role);

  if (type === 'worker.spawned') {
    return `${rt} ${prof} — running (${model ?? '?'})`;
  }
  if (type === 'worker.completed') {
    return `${rt} ${prof} — done`;
  }
  if (type === 'worker.failed' || type === 'worker.timeout') {
    const err = errors?.[0] ?? type;
    return `${rt} ${prof} — failed (${err})`;
  }
  if (type === 'step.started') {
    return `— step ${stepId} —`;
  }
  if (type === 'run.awaiting_judgment') {
    return 'Awaiting orchestrator judgment…';
  }
  if (type === 'run.completed') {
    return `Run completed (${status ?? 'ok'})`;
  }
  if (type === 'run.failed') {
    return `Run failed: ${(errors ?? []).join('; ')}`;
  }
  if (type === 'worker.output' && chunk) {
    const lines = String(chunk).split('\n');
    for (const line of lines) {
      const activity = activityFromStreamJsonLine(line);
      if (activity) return activity;
    }
  }
  return null;
}

export function shouldUseHumanProgress({ teeHuman, isTty = process.stderr.isTTY } = {}) {
  if (teeHuman === false) return false;
  if (teeHuman === true) return true;
  return Boolean(isTty);
}
