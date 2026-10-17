// Stand-in for claude / codex / agent in tests. Behaviour is driven by markers
// in the prompt: FAKE_WRITE writes a file in cwd, FAKE_SLEEP hangs, FAKE_FAIL exits 3,
// FAKE_MODEL=<id> reports <id> as the model the CLI ran, FAKE_TOO_OLD rejects like an outdated CLI.
const fs = require('node:fs');
const path = require('node:path');

const [runtime, ...args] = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(`9.9.9 (fake ${runtime})`);
  process.exit(0);
}
if (runtime === 'cursor' && args.includes('--list-models')) {
  console.log('Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5 (current)\ngpt-5.2 - GPT-5.2\ncomposer-2.5-fast - Composer 2.5 Fast\ngrok-4.7-high - Grok 4.7  High\ngrok-4.7-high-fast - Grok 4.7  High Fast\u200b\ncursor-grok-4.6-high - Grok 4.6\nclaude-opus-5-5-high - Claude Opus 5.5 1M High');
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
  const reported = /FAKE_MODEL=(\S+)/.exec(input)?.[1];
  if (input.includes('FAKE_TOO_OLD')) {
    const message = `API Error: 400 The model ${model} requires Claude Code 2.1.280 or later. Run claude update.`;
    process.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, result: message })}\n`);
    process.exit(1);
  }
  if (runtime === 'claude' && model === 'fable') {
    process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, result: 'Fable 5 requires usage credits.' })}\n`);
    process.exit(1);
  }
  const report = `fake ${runtime} report\nmodel=${model}\nreadonly=${input.includes('You are read-only')}\nsrc/index.mjs:1 cited`;
  if (runtime === 'codex') {
    fs.writeFileSync(flag('-o'), report);
    process.stderr.write(`model: ${reported ?? model}\ncodex\nReading the brief first.\nexec\n/bin/zsh -lc "rg foo" in /tmp\nsucceeded in 3ms:\n`);
    process.exit(0);
  }
  const lines = [
    { type: 'system', subtype: 'init', model: reported ?? `claude-${model}-fake` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Tracing the fake write path. Then more.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${process.cwd()}/src/index.mjs` } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: report }] } },
    { type: 'result', subtype: 'success', result: report },
  ];
  for (const l of lines) process.stdout.write(`${JSON.stringify(l)}\n`);
});
