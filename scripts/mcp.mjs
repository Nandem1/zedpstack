#!/usr/bin/env node
import { startMcpServer } from '../src/mcp/server.mjs';

startMcpServer().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
