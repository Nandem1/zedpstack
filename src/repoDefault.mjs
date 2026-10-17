/** Same default repo root as MCP tools (`ZEDPSTACK_REPO` or cwd). */
export function defaultZedpstackRepo(env = process.env, cwd = process.cwd()) {
  return env.ZEDPSTACK_REPO ?? cwd;
}
