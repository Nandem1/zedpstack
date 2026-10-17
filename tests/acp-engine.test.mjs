import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineCommand } from '../src/acp/engine.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'bin', 'fake-acp-agent.cjs');

describe('resolveEngineCommand', () => {
  it('env override wins', () => {
    const cmd = resolveEngineCommand('claude', {
      env: { ZEDPSTACK_ACP_ENGINE_CLAUDE: JSON.stringify([process.execPath, FAKE]) },
      userConfig: { acp: { engines: { claude: ['npx', 'other'] } } },
      registry: { agents: [{ id: 'claude-acp', distribution: { npx: { package: '@x/y' } } }] },
    });
    assert.deepEqual(cmd, [process.execPath, FAKE]);
  });

  it('userConfig acp.engines over registry', () => {
    const cmd = resolveEngineCommand('claude', {
      env: {},
      userConfig: { acp: { engines: { claude: ['node', 'cfg.js'] } } },
      registry: { agents: [{ id: 'claude-acp', distribution: { npx: { package: '@x/y' } } }] },
    });
    assert.deepEqual(cmd, ['node', 'cfg.js']);
  });

  it('registry npx package', () => {
    const cmd = resolveEngineCommand('claude', {
      env: {},
      userConfig: {},
      registry: { agents: [{ id: 'claude-acp', distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@1.0.0' } } }] },
    });
    assert.deepEqual(cmd, ['npx', '-y', '@agentclientprotocol/claude-agent-acp@1.0.0']);
  });

  it('pinned fallback', () => {
    const cmd = resolveEngineCommand('claude', { env: {}, userConfig: {}, registry: null });
    assert.deepEqual(cmd[0], 'npx');
    assert.match(cmd[2], /claude-agent-acp@0\.93\.0/);
  });
});
