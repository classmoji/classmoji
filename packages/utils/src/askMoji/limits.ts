/**
 * Ask Moji's limits, shared by the server that enforces them
 * (askMojiChat.service, the ask-moji task) and the widget that states them.
 * Numbers only. A conversation has no turn limit and no expiry: it lasts
 * until the user starts a new one, and the task compacts long histories.
 */
import { MIN_TURN_INTERVAL_MS } from '../agents/limits.ts';

/** The longest typed message, in characters. */
export const MAX_MESSAGE_CHARS = 4_000;

/** Model steps in one reply (`stopWhen: stepCountIs(n)`). */
export const MAX_STEPS_PER_TURN = 10;

/** Course lookups (wrapped MCP tool calls) in one reply. */
export const MAX_LOOKUPS_PER_TURN = 6;

/** How long one reply may run before it is stopped. */
export const TURN_DEADLINE_MS = 120_000;

/** The shortest time between two admitted messages (the quiz's, one copy). */
export { MIN_TURN_INTERVAL_MS };

/** Conversations one user may start, across classrooms, within the window. */
export const START_RATE_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 } as const;

/** Version of the stored message contract (`contract_version` on each row and grant). */
export const CONTRACT_VERSION = 1;
