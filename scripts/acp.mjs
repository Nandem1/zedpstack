#!/usr/bin/env node
import { startAcpServer } from '../src/acp/server.mjs';

startAcpServer().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
