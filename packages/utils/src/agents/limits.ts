/**
 * Numbers every chat agent's admission shares (`@classmoji/utils/agents/limits`).
 * No server imports: the screens that state them read this module too.
 */

/**
 * The shortest time between two admitted turns of one conversation, measured
 * from the previous admission, not from the reply to it. The chat sends
 * nothing while a reply is running and a reply takes longer than this, so
 * only a scripted sender meets it. The quiz (quizChat.service) and Ask Moji
 * (askMojiChat.service) read this one copy.
 */
export const MIN_TURN_INTERVAL_MS = 3_000;
