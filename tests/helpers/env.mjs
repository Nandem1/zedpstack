export function childEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.ZEDPSTACK_AGENT_ID;
  delete env.ZEDPSTACK_ACP_SESSION;
  delete env.ZEDPSTACK_ACP_BRIDGE;
  return { ...env, ...overrides };
}
