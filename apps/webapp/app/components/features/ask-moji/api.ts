/**
 * The panel's calls to `/api/ask-moji/:class/*` (the webapp's own origin, so
 * the session cookie rides along; inside the pages/slides frame too, since
 * the frame IS the webapp).
 *
 * Every failure becomes an `AskMojiApiError` whose `line` is fixed copy: the
 * reply's `message` when it is one of `ASK_MOJI_COPY`'s lines, else a line
 * picked for the call. A network failure or an unreadable body never shows
 * its own text.
 */
import {
  ASK_MOJI_AVAILABILITY_COPY,
  ASK_MOJI_COPY,
  isAskMojiErrorCopy,
  type AskMojiRole,
  type AskMojiSuggestion,
  type AskMojiUIMessage,
} from '@classmoji/utils/ask-moji';

export type AskMojiRating = 'UP' | 'DOWN';

/** `start` / `new`: the conversation the panel opens on. */
export interface AskMojiOpened {
  ok: true;
  conversationId: string;
  publicAccessToken: string;
  sessionReady: boolean;
  resumeCursor: string | null;
  transcript: AskMojiUIMessage[];
  ratings: Record<string, AskMojiRating>;
  welcome: string;
  suggestions: readonly AskMojiSuggestion[];
  viewAs: AskMojiRole;
  state: { status: 'ACTIVE'; lastMessageId: string | null; inFlight: boolean };
  created: boolean;
}

/** `state`: the poll's answer. */
export interface AskMojiState {
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  conversationId: string | null;
  lastMessageId: string | null;
  inFlight: boolean;
  resumeCursor: string | null;
  transcript?: AskMojiUIMessage[];
}

export class AskMojiApiError extends Error {
  /** The reply's code (`NOT_FOUND`, `UNAVAILABLE`, …), or null for a network failure. */
  code: string | null;
  status: number;
  /** Fixed copy for the user. */
  line: string;
  /** Why Ask Moji is unavailable, for OWNER/TEACHER only (fixed staff copy). */
  staffLine: string | null;
  permanent: boolean;
  constructor(i: {
    code: string | null;
    status: number;
    line: string;
    staffLine?: string | null;
    permanent?: boolean;
  }) {
    super(i.line);
    this.name = 'AskMojiApiError';
    this.code = i.code;
    this.status = i.status;
    this.line = i.line;
    this.staffLine = i.staffLine ?? null;
    this.permanent = i.permanent ?? false;
  }
}

const STAFF_LINES: readonly string[] = Object.values(ASK_MOJI_AVAILABILITY_COPY);

export interface AskMojiApi {
  start(i: { viewAs?: string | null; browserTimeZone?: string | null }): Promise<AskMojiOpened>;
  newConversation(i: {
    conversationId: string;
    viewAs?: string | null;
    browserTimeZone?: string | null;
  }): Promise<AskMojiOpened>;
  ensureSession(i: { conversationId: string }): Promise<{ publicAccessToken: string }>;
  token(i: { conversationId: string }): Promise<{ publicAccessToken: string }>;
  /** Null: the conversation is not the caller's (or no longer exists). */
  state(i: {
    conversationId: string;
    knownLastMessageId: string | null;
  }): Promise<AskMojiState | null>;
  end(i: { conversationId: string }): Promise<{ changed: boolean }>;
  feedback(i: {
    conversationId: string;
    uiMessageId: string;
    rating: AskMojiRating | null;
  }): Promise<{ rating: AskMojiRating | null }>;
}

type Fetch = typeof fetch;

/** The client for one classroom. `fetchImpl` is for tests. */
export function createAskMojiApi(classroomSlug: string, fetchImpl: Fetch = fetch): AskMojiApi {
  const base = `/api/ask-moji/${encodeURIComponent(classroomSlug)}`;

  const post = async <T>(
    path: string,
    body: Record<string, unknown>,
    fallback: string
  ): Promise<{ status: number; data: T }> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
    } catch {
      throw new AskMojiApiError({ code: null, status: 0, line: fallback });
    }
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !data) {
      const message = data?.message;
      const staff = data?.staffMessage;
      throw new AskMojiApiError({
        code: typeof data?.code === 'string' ? data.code : null,
        status: response.status,
        line: isAskMojiErrorCopy(message) ? message : fallback,
        staffLine: typeof staff === 'string' && STAFF_LINES.includes(staff) ? staff : null,
        permanent: data?.permanent === true,
      });
    }
    return { status: response.status, data: data as T };
  };

  const clean = (v: string | null | undefined) => (v ? v : undefined);

  return {
    start: async ({ viewAs, browserTimeZone }) =>
      (
        await post<AskMojiOpened>(
          'start',
          { viewAs: clean(viewAs), browserTimeZone: clean(browserTimeZone) },
          ASK_MOJI_COPY.INIT_FAILED
        )
      ).data,
    newConversation: async ({ conversationId, viewAs, browserTimeZone }) =>
      (
        await post<AskMojiOpened>(
          'new',
          { conversationId, viewAs: clean(viewAs), browserTimeZone: clean(browserTimeZone) },
          ASK_MOJI_COPY.INIT_FAILED
        )
      ).data,
    ensureSession: async ({ conversationId }) =>
      (
        await post<{ publicAccessToken: string }>(
          'ensure-session',
          { conversationId },
          ASK_MOJI_COPY.CONNECTION_FAILED
        )
      ).data,
    token: async ({ conversationId }) =>
      (
        await post<{ publicAccessToken: string }>(
          'token',
          { conversationId },
          ASK_MOJI_COPY.CONNECTION_FAILED
        )
      ).data,
    state: async ({ conversationId, knownLastMessageId }) => {
      try {
        return (
          await post<AskMojiState>(
            'state',
            { conversationId, knownLastMessageId },
            ASK_MOJI_COPY.CONNECTION_FAILED
          )
        ).data;
      } catch (error) {
        if (error instanceof AskMojiApiError && error.status === 404) return null;
        throw error;
      }
    },
    end: async ({ conversationId }) =>
      (await post<{ changed: boolean }>('end', { conversationId }, ASK_MOJI_COPY.ERROR)).data,
    feedback: async ({ conversationId, uiMessageId, rating }) =>
      (
        await post<{ rating: AskMojiRating | null }>(
          'feedback',
          { conversationId, uiMessageId, rating },
          ASK_MOJI_COPY.ERROR
        )
      ).data,
  };
}
