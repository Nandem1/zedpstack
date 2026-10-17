#!/usr/bin/env node
import { appendDenialAudit, decide } from '../src/guard.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString('utf8').trim();
if (!raw) process.exit(0);

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const tool = payload.tool_name ?? payload.tool;
const input = payload.tool_input ?? payload.input ?? {};
const cwd = payload.cwd ?? process.cwd();
const verdict = decide({ tool, input, cwd, env: process.env });

if (verdict.deny) {
  if (verdict.repoRoot) appendDenialAudit(verdict.repoRoot, { tool, path: verdict.auditPath });
  process.stderr.write(`${verdict.reason}\n`);
  process.exit(2);
}
