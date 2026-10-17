/**
 * Agent board: one block per subagent, modelled on Cursor's subagent list.
 *
 *   ⠿ How: backend tracking SQL  composer-2.5 · Cursor
 *     > Searching for "UPDATE tracking"
 */

import fs from 'node:fs';
import path from 'node:path';
import { agentDir } from './store.mjs';

const RUNTIME_LABEL = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STATUS_ICON = { starting: '⠿', running: '⠿', completed: '✓', failed: '✗', stopped: '■' };

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_]+/g, '-');

/** `opus → claude-opus-4-8` when the CLI resolved an alias to something else. */
export function modelLabel(model, effectiveModel) {
  if (!effectiveModel) return model;
  const eff = effectiveModel.replace(/-\d{8}$/, '');
  if (norm(eff) === norm(model)) return model;
  return `${model} → ${eff}`;
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Last activity line from progress.log, without the narration bullet. */
export function lastActivity(repoRoot, id) {
  const file = path.join(agentDir(repoRoot, id), 'progress.log');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.startsWith('> ')) return line;
    if (line.startsWith('· ')) return line.slice(2);
  }
  return null;
}

/** @param {object[]} views AgentViews from `loadAgent` */
export function boardRows(repoRoot, views, now = Date.now()) {
  return views.map((v) => {
    const { spec, run } = v;
    const start = Date.parse(run?.startedAt ?? spec.createdAt);
    const end = v.finishedAt ? Date.parse(v.finishedAt) : now;
    let detail;
    if (v.status === 'completed') {
      const files = run.outcome.changes?.files?.length;
      detail = `done in ${formatElapsed(end - start)}${files ? ` · ${files} file${files === 1 ? '' : 's'} changed on ${spec.worktree?.branch ?? 'branch'}` : ''}`;
    } else if (v.status === 'failed') {
      detail = `failed: ${v.error ?? 'unknown error'}`;
    } else if (v.status === 'stopped') {
      detail = 'stopped';
    } else {
      detail = lastActivity(repoRoot, spec.id) ?? (v.status === 'starting' ? 'Starting…' : 'Working…');
    }
    return {
      id: spec.id,
      status: v.status,
      title: spec.description ?? spec.role ?? spec.id,
      model: modelLabel(spec.binding.model, run?.effectiveModel),
      runtime: RUNTIME_LABEL[spec.binding.runtime] ?? spec.binding.runtime,
      readonly: spec.binding.permissionProfile === 'read-only',
      elapsed: formatElapsed(end - start),
      detail,
    };
  });
}

function summaryLine(rows) {
  const count = (pred) => rows.filter(pred).length;
  const running = count((r) => r.status === 'running' || r.status === 'starting');
  const parts = [];
  if (running) parts.push(`${running} running`);
  const done = count((r) => r.status === 'completed');
  if (done) parts.push(`${done} done`);
  const failed = count((r) => r.status === 'failed');
  if (failed) parts.push(`${failed} failed`);
  const stopped = count((r) => r.status === 'stopped');
  if (stopped) parts.push(`${stopped} stopped`);
  return `zedpstack · ${parts.join(' · ') || 'no agents'}`;
}

/**
 * Plain text, for tool results and logs.
 * @param {{ frame?: number, header?: boolean }} opts
 */
export function formatBoardText(rows, { frame = null, header = true } = {}) {
  const out = header ? [summaryLine(rows)] : [];
  for (const r of rows) {
    const live = r.status === 'running' || r.status === 'starting';
    const icon = live && frame !== null ? SPINNER[frame % SPINNER.length] : STATUS_ICON[r.status] ?? '•';
    out.push(`${icon} ${r.title}  ${r.model} · ${r.runtime}${r.readonly ? '' : ' · writer'}`);
    out.push(`  ${r.detail}`);
  }
  return out.join('\n');
}

/** Markdown, the shape the orchestrator copies into its chat message. */
export function formatBoardMarkdown(rows) {
  return rows
    .map((r) => {
      const live = r.status === 'running' || r.status === 'starting';
      const icon = live ? '⠿' : STATUS_ICON[r.status] ?? '•';
      return `- ${icon} **${r.title}** · ${r.model} (${r.runtime})  \n  ${r.detail.replace(/\*/g, '\\*')}`;
    })
    .join('\n');
}

const ansi = (code, s) => `\x1b[${code}m${s}\x1b[0m`;

/** Colored, for `dispatch top`. */
export function formatBoardAnsi(rows, { frame = 0, repoRoot, width: rawWidth } = {}) {
  const width = rawWidth >= 40 ? rawWidth : 100;
  const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);
  const out = [ansi('1', summaryLine(rows)) + ansi('2', `  ${repoRoot ?? ''}`), ''];
  if (!rows.length) out.push(ansi('2', '  No agents yet. Waiting for spawn_agent…'));
  for (const r of rows) {
    const live = r.status === 'running' || r.status === 'starting';
    const icon = live
      ? ansi('36', SPINNER[frame % SPINNER.length])
      : r.status === 'completed'
        ? ansi('32', '✓')
        : r.status === 'failed'
          ? ansi('31', '✗')
          : ansi('33', '■');
    const meta = `${r.model} · ${r.runtime}${r.readonly ? '' : ' · writer'} · ${r.elapsed}`;
    out.push(`${icon} ${ansi('1', clip(r.title, Math.max(20, width - meta.length - 6)))}  ${ansi('2', meta)}`);
    const color = r.status === 'failed' ? '31' : '2';
    out.push(`  ${ansi(color, clip(r.detail, width - 4))}`);
    out.push('');
  }
  out.push(ansi('2', 'q / Ctrl-C to quit'));
  return out.join('\n');
}
