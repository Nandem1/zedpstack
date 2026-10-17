export const AUTH_POLICY = {
  claude: {
    hint: 'ejecuta `claude auth login` o configura ANTHROPIC_API_KEY',
    methods: [{ id: 'claude-login', credentials: 'CLI de Claude o ANTHROPIC_API_KEY' }],
  },
  codex: {
    hint: 'ejecuta `codex login` o configura CODEX_API_KEY u OPENAI_API_KEY en el entorno del hub',
    methods: [
      { id: 'chat-gpt', credentials: 'login existente de ChatGPT/Codex' },
      { id: 'api-key', credentials: 'CODEX_API_KEY u OPENAI_API_KEY', env: ['CODEX_API_KEY', 'OPENAI_API_KEY'] },
    ],
  },
  cursor: {
    hint: 'ejecuta `agent login`',
    methods: [{ id: 'cursor_login', credentials: 'login existente de Cursor' }],
  },
};

export function selectAuthMethod(runtime, methods, env = {}) {
  const policy = AUTH_POLICY[runtime];
  for (const allowed of policy?.methods ?? []) {
    if (allowed.env && !allowed.env.some((key) => env[key]?.trim())) continue;
    const method = methods.find((method) => method.id === allowed.id);
    if (method) return method;
  }
  const available = methods.map(({ id, name }) => `${id}${name ? ` (${name})` : ''}`).join(', ') || 'ninguno';
  throw new Error(`no usable authentication method for ${runtime}. Disponibles: ${available}. ${policy?.hint ?? 'comprueba el login del CLI'}`);
}
