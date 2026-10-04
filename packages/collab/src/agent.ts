/**
 * Agents in awareness: what the collab server publishes for an agent session
 * (an MCP client editing on someone's behalf) and what the editors read back.
 *
 * The server keeps one awareness entry per (document, user, agent session):
 *
 *   { user: { name: '<name> (agent)' | '<name> (agent 2)', color, agent: true },
 *     blockId? | slide?,          what it last touched (page block / deck slide)
 *     touched?: { ids, seq },     what its last op batch inserted or changed
 *     cursor?: { anchor, head } } pages: its caret, as y-prosemirror reads it
 *
 * Pure: no DOM, no Yjs. The server, both editors and MCP import it.
 */

import { USER_COLORS, colorHash } from './color.ts';

/** At most this many ids in one batch's `touched` list (the last ones win). */
export const AGENT_TOUCHED_MAX = 40;

/** How long a touched block or slide stays highlighted (ms). */
export const AGENT_TOUCH_FADE_MS = 5_000;

/** When a touch is forgotten: a little after its fade has finished. */
export const AGENT_TOUCH_EXPIRE_MS = 5_500;

/** What one op batch inserted or changed; `seq` grows by one per batch. */
export interface AgentTouched {
  ids: string[];
  seq: number;
}

/** A caret as y-prosemirror's cursor plugin reads it (Y.RelativePosition JSON). */
export interface AgentCursor {
  anchor: unknown;
  head: unknown;
}

/** The awareness state of an agent session. */
export interface AgentAwarenessState {
  user: { name: string; color: string; agent: true };
  blockId?: string;
  slide?: string;
  touched?: AgentTouched;
  cursor?: AgentCursor | null;
}

// ─── Session ids ─────────────────────────────────────────────────────────────

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * An agent session id as sent by a client (MCP: the `Mcp-Session-Id` header),
 * or null when it is missing or not a plain token. Only ever used as a key:
 * never shown, never trusted for access.
 */
export function normalizeAgentSession(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null;
}

// ─── Names ───────────────────────────────────────────────────────────────────

/**
 * The name an agent session shows under: `<name> (agent)` when it is the
 * user's only agent session in the document, else `<name> (agent N)`, N
 * counting their sessions there by first activity.
 */
export function agentDisplayName(name: string, number: number | null): string {
  return number === null ? `${name} (agent)` : `${name} (agent ${number})`;
}

const AGENT_NAME = /^(.*?)\s*\((agent(?: \d{1,4})?)\)\s*$/i;

/**
 * An awareness name split into the person's name and the agent tag
 * (`'agent'`, `'agent 2'`), or a null tag for a person.
 */
export function splitAgentName(name: string): { name: string; tag: string | null } {
  const match = AGENT_NAME.exec(name);
  if (!match) return { name: name.trim(), tag: null };
  return { name: match[1].trim() || name.trim(), tag: match[2].toLowerCase() };
}

// ─── Colours ─────────────────────────────────────────────────────────────────

/**
 * The colour of an agent session: picked from the user palette by the
 * session key, skipping `avoid` (the person's own colour and their other
 * sessions' colours) while the palette has room.
 */
export function agentColor(key: string, avoid: Iterable<string> = []): string {
  const taken = new Set([...avoid].map(color => color.toLowerCase()));
  const start = colorHash(`agent:${key}`) % USER_COLORS.length;
  for (let i = 0; i < USER_COLORS.length; i++) {
    const color = USER_COLORS[(start + i) % USER_COLORS.length];
    if (!taken.has(color)) return color;
  }
  return USER_COLORS[start];
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Black or white text, whichever reads on `color` (WCAG relative luminance). */
export function textOnColor(color: string): '#000000' | '#ffffff' {
  if (!HEX_COLOR.test(color)) return '#ffffff';
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#000000' : '#ffffff';
}

// ─── Touches, as an editor sees them ─────────────────────────────────────────
const FALLBACK_COLOR = '#6b7280';

/** One agent batch read from awareness. */
export interface AgentBatch {
  clientId: number;
  seq: number;
  ids: string[];
  /** The full awareness name (`<name> (agent)`). */
  name: string;
  /** Always a 6-digit hex colour (anything else reads as grey). */
  color: string;
}

/**
 * The `touched` batches in awareness states: agents only (`user.agent`),
 * never the local client, well-formed lists only (string ids, a finite seq,
 * at most AGENT_TOUCHED_MAX ids — a longer list is cut to its last ones).
 */
export function agentBatchesFromStates(
  states: Iterable<[number, unknown]>,
  localClientId: number
): AgentBatch[] {
  const out: AgentBatch[] = [];
  for (const [clientId, raw] of states) {
    if (clientId === localClientId || !raw || typeof raw !== 'object') continue;
    const state = raw as { user?: unknown; touched?: unknown };
    const user = state.user as { name?: unknown; color?: unknown; agent?: unknown } | undefined;
    if (!user || user.agent !== true || typeof user.name !== 'string' || !user.name) continue;
    const touched = state.touched as { ids?: unknown; seq?: unknown } | undefined;
    if (!touched || !Array.isArray(touched.ids) || typeof touched.seq !== 'number') continue;
    if (!Number.isFinite(touched.seq)) continue;
    const ids = touched.ids
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
      .slice(-AGENT_TOUCHED_MAX);
    if (ids.length === 0) continue;
    out.push({
      clientId,
      seq: touched.seq,
      ids,
      name: user.name.slice(0, 200),
      color:
        typeof user.color === 'string' && HEX_COLOR.test(user.color) ? user.color : FALLBACK_COLOR,
    });
  }
  return out;
}

/** A block or slide an agent touched, as long as it shows. */
export interface AgentTouch {
  id: string;
  clientId: number;
  seq: number;
  name: string;
  color: string;
  /** When this editor first saw the batch (its own clock). */
  at: number;
  /** This editor's own count of batches seen, unique per batch (names its fade). */
  batch: number;
}

/**
 * Which blocks/slides show an agent's touch right now. A batch counts from
 * the moment this editor first sees its `(clientId, seq)` — never a server
 * time — and is forgotten AGENT_TOUCH_EXPIRE_MS later. The same state sent
 * again (a renewal, a new `user`) does not restart it; each id belongs to the
 * batch that touched it last.
 */
export class AgentTouchTracker {
  private readonly seen = new Map<number, number>();
  private readonly byId = new Map<string, AgentTouch>();
  private batches = 0;
  private readonly now: () => number;
  private readonly expireMs: number;

  constructor(now: () => number = () => Date.now(), expireMs: number = AGENT_TOUCH_EXPIRE_MS) {
    this.now = now;
    this.expireMs = expireMs;
  }

  /** Read the current awareness states; true when the touches changed. */
  update(states: Iterable<[number, unknown]>, localClientId: number): boolean {
    let changed = this.sweep();
    const at = this.now();
    for (const batch of agentBatchesFromStates(states, localClientId)) {
      if (this.seen.get(batch.clientId) === batch.seq) continue;
      this.seen.set(batch.clientId, batch.seq);
      const number = ++this.batches;
      for (const id of batch.ids) {
        this.byId.set(id, {
          id,
          clientId: batch.clientId,
          seq: batch.seq,
          name: batch.name,
          color: batch.color,
          at,
          batch: number,
        });
      }
      changed = true;
    }
    return changed;
  }

  /** Forget expired touches; true when any went. */
  sweep(): boolean {
    const now = this.now();
    let changed = false;
    for (const [id, touch] of this.byId) {
      if (now - touch.at >= this.expireMs) {
        this.byId.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** The touches showing now, oldest batch first. */
  touches(): AgentTouch[] {
    return [...this.byId.values()].sort((a, b) => a.batch - b.batch);
  }

  /** Milliseconds until the next touch expires, or null when none shows. */
  nextExpiryIn(): number | null {
    let next: number | null = null;
    const now = this.now();
    for (const touch of this.byId.values()) {
      const left = Math.max(0, touch.at + this.expireMs - now);
      if (next === null || left < next) next = left;
    }
    return next;
  }
}
