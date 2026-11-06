/**
 * Whether THIS process can reach Trigger.dev: `TRIGGER_SECRET_KEY` or
 * `TRIGGER_ACCESS_TOKEN` is set. Presence only; a wrong key fails at the call.
 *
 * The one copy of the rule. Quizzes (`entitlement.isQuizRuntimeConfigured`),
 * Ask Moji on Trigger (`askMojiSession.askMojiAvailable`), team-set solves,
 * the quiz chat session route and the classroom import all ask here, so they
 * cannot disagree about whether this deployment has Trigger.
 *
 * Its own module (and the `@classmoji/services/trigger-config` subpath) so a
 * caller can import it without the services index, which tests mock wholesale.
 */
export const isTriggerConfigured = (): boolean =>
  Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN);
