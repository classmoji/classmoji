/**
 * Which runtime serves Ask Moji (`ASK_MOJI_RUNTIME`), parsed in one place for
 * every app that reads it (services, webapp, MCP, pages, slides).
 *
 *   'trigger'   the `ask-moji` chat agent on Trigger.dev
 *   'ai_agent'  the AI agent's WebSocket path: unset, empty, `ai_agent`, and
 *               any other value (which warns once per process)
 *
 * The match is exact, as every reader's check was before this helper. No
 * server imports: this module reaches the client bundle, where `process` may
 * not exist (it reads as unset there).
 */

export const ASK_MOJI_RUNTIMES = ['trigger', 'ai_agent'] as const;
export type AskMojiRuntime = (typeof ASK_MOJI_RUNTIMES)[number];

type Env = Readonly<Record<string, string | undefined>>;

const processEnv = (): Env =>
  typeof process !== 'undefined' && process.env ? (process.env as Env) : {};

let warned = false;

/** The runtime `env.ASK_MOJI_RUNTIME` names (see the header). */
export function askMojiRuntime(env: Env = processEnv()): AskMojiRuntime {
  const value = env.ASK_MOJI_RUNTIME;
  if (value === 'trigger') return 'trigger';
  if (value === undefined || value === '' || value === 'ai_agent') return 'ai_agent';
  if (!warned) {
    warned = true;
    console.warn(
      `[ask-moji] ASK_MOJI_RUNTIME=${JSON.stringify(value)} is not "trigger" or "ai_agent"; using "ai_agent"`
    );
  }
  return 'ai_agent';
}

/** Whether Ask Moji runs on the Trigger runtime (`askMojiRuntime(env) === 'trigger'`). */
export const isAskMojiTriggerRuntime = (env: Env = processEnv()): boolean =>
  askMojiRuntime(env) === 'trigger';

/** Test hook: forget that the unknown-value warning was printed. */
export const resetAskMojiRuntimeWarning = () => {
  warned = false;
};
