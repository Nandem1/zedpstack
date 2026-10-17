#!/usr/bin/env node
import { startMcpServer } from '../src/mcp/server.mjs';

startMcpServer().then(
  () => process.stdout.write('', () => process.exit(0)),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
