// Stand-in for claude / codex / agent in tests. Behaviour is driven by markers
// in the prompt: FAKE_WRITE writes a file in cwd, FAKE_SLEEP hangs, FAKE_FAIL exits 3.
const fs = require('node:fs');
const path = require('node:path');

const [runtime, ...args] = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(`9.9.9 (fake ${runtime})`);
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('  --tools <tools...>  fake help');
  process.exit(0);
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  // Workers only receive allowlisted env vars, so the call log goes through TMPDIR.
  if (process.env.TMPDIR) {
    fs.appendFileSync(path.join(process.env.TMPDIR, 'fake-cli.log'), `${JSON.stringify({ runtime, args, cwd: process.cwd() })}\n`);
  }
  if (input.includes('FAKE_SLEEP')) {
    setTimeout(() => {}, 120000);
    return;
  }
  if (input.includes('FAKE_FAIL')) {
    process.stderr.write('fake failure\n');
    process.exit(3);
  }
  if (input.includes('FAKE_WRITE')) {
    fs.writeFileSync(path.join(process.cwd(), 'fake-output.txt'), `written by fake ${runtime}\n`);
  }
  const model = flag('--model') ?? flag('-m');
  const report = `fake ${runtime} report\nmodel=${model}\nreadonly=${input.includes('You are read-only')}\nsrc/index.mjs:1 cited`;
  if (runtime === 'codex') {
    fs.writeFileSync(flag('-o'), report);
    process.stderr.write(`model: ${model}\ncodex\nReading the brief first.\nexec\n/bin/zsh -lc "rg foo" in /tmp\nsucceeded in 3ms:\n`);
    process.exit(0);
  }
  const lines = [
    { type: 'system', subtype: 'init', model: `claude-${model}-fake` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Tracing the fake write path. Then more.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${process.cwd()}/src/index.mjs` } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: report }] } },
    { type: 'result', subtype: 'success', result: report },
  ];
  for (const l of lines) process.stdout.write(`${JSON.stringify(l)}\n`);
});
