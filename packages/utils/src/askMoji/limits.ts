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

/**
 * How long after admission a turn with no settled marker still counts as in
 * flight (`TURN_DEADLINE_MS` plus a margin for persisting). Past it the turn is
 * over whatever happened to its run, so a crashed run never leaves the widget
 * waiting. The UI flag only: admission never refuses on it.
 */
export const IN_FLIGHT_STALE_MS = TURN_DEADLINE_MS + 60_000;

/** The highest slide index `viewing.slide` may name (the server clamps to it). */
export const MAX_SLIDE_INDEX = 999;

/** Compact the model's history once a call's input passes this many tokens. */
export const COMPACT_AT_INPUT_TOKENS = 80_000;

/** User turns kept verbatim after a compaction (older ones are summarized). */
export const KEEP_RECENT_TURNS = 6;

/** How often the open widget polls `state` while its tab is visible. */
export const STATE_POLL_MS = 4_000;

/** The longest owner instructions, in characters (`syllabus_bot_instructions`). */
export const INSTRUCTIONS_MAX_CHARS = 4_000;

/** Insight rows about one material show only with at least this many distinct askers. */
export const INSIGHT_MIN_ASKERS = 3;

/** Weeks the usage view may cover. */
export const INSIGHT_MAX_WEEKS = 26;

/** Rows the feedback review returns at most per call. */
export const FEEDBACK_REVIEW_MAX_LIMIT = 100;
