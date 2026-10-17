import { spawn } from 'node:child_process';
import { createPeer } from '../../src/acp/rpc.mjs';

export function startHubProcess(t, env) {
  const child = spawn(process.execPath, [new URL('../../scripts/acp.mjs', import.meta.url).pathname], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const peer = createPeer({ input: child.stdout, output: child.stdin });
  peer.onRequest(async (_method, params) => ({ outcome: {
    outcome: 'selected', optionId: params.options?.find((option) => option.kind === 'allow_once')?.optionId ?? 'ok',
  } }));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); peer.close(); }
  });
  return { child, peer, exited, stderr: () => stderr };
}
