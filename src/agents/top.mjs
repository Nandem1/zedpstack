import { agentBoard } from './lifecycle.mjs';
import { formatBoardAnsi, formatBoardText } from './board.mjs';

/**
 * Live agent board for a terminal pane (`dispatch top`). Redraws in place on
 * the alternate screen; q or Ctrl-C restores the terminal.
 */
export async function runTop({ repoRoot, recentMinutes = 30, intervalMs = 400, once = false, out = process.stdout }) {
  const rows = () => agentBoard({ repo: repoRoot, recentMinutes });
  if (once || !out.isTTY) {
    out.write(`${formatBoardText(rows())}\n`);
    return;
  }

  let frame = 0;
  let stopped = false;
  const restore = () => {
    if (stopped) return;
    stopped = true;
    out.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };
  out.write('\x1b[?1049h\x1b[?25l');
  process.on('exit', restore);
  process.on('SIGINT', () => {
    restore();
    process.exit(0);
  });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      const k = key.toString();
      if (k === 'q' || k === '\u0003') {
        restore();
        process.exit(0);
      }
    });
  }

  while (!stopped) {
    let screen;
    try {
      screen = formatBoardAnsi(rows(), { frame, repoRoot, width: out.columns });
    } catch (err) {
      screen = `zedpstack top: ${err.message}`;
    }
    out.write(`\x1b[H\x1b[2J${screen}`);
    frame += 1;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
