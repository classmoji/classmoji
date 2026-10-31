/**
 * The quiz chat agent's tasks (`quiz-attempt`, `explore-repo`), which live in
 * the private ai-agent submodule (apps/ai-agent/src/trigger). Trigger.dev only
 * registers task files inside this project, so this one-line entry re-exports
 * them from here.
 *
 * trigger.config.js lists this directory only when the submodule's entry
 * exists, so a checkout without the submodule never imports this file; a
 * deploy without it refuses to build. JavaScript on purpose, and excluded in
 * tsconfig.json: neither the typed lint nor this project's typecheck reads
 * it; the ai-agent package typechecks and tests its own code.
 */
// eslint-disable-next-line import/no-unresolved -- the submodule may be absent
export * from '@classmoji/ai-agent/trigger';
