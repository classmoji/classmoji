import { io, Socket } from 'socket.io-client';
import type { BrowserContext } from '@playwright/test';
import { getSlidesBaseURL } from './env.helpers';

/**
 * Raw Socket.IO test client for the slides `/multiplex` namespace
 * (apps/slides/server.ts), which syncs the presenter's slide to followers.
 * Authentication mirrors the production server:
 *   - Classroom members connect via the session cookie
 *     (`classmoji.session_token`); OWNER/TEACHER members may broadcast.
 *   - Public followers connect with a `shareCode` query param that must equal
 *     the slide's `multiplex_id`.
 */

export interface SlideChangedEvent {
  indexh: number;
  indexv: number;
}

/**
 * Serialize a browser context's cookies into a `Cookie` request header so the
 * Node socket client authenticates as the same logged-in user.
 */
export async function cookieHeaderFromContext(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

interface ConnectOptions {
  /** Cookie header for authenticated connections (member/owner). */
  cookieHeader?: string;
  /** shareCode for public follower connections (must equal slide.multiplex_id). */
  shareCode?: string;
}

/**
 * Open a Socket.IO connection to the `/multiplex` namespace and resolve once
 * connected. Rejects if the connection errors (e.g. UNAUTHENTICATED).
 */
export function connectMultiplex(opts: ConnectOptions = {}): Promise<Socket> {
  const baseUrl = getSlidesBaseURL();
  const query: Record<string, string> = {};
  if (opts.shareCode) query.shareCode = opts.shareCode;

  const socket = io(`${baseUrl}/multiplex`, {
    path: '/socket.io',
    transports: ['websocket'],
    forceNew: true,
    query,
    extraHeaders: opts.cookieHeader ? { cookie: opts.cookieHeader } : undefined,
  });

  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out connecting to /multiplex namespace'));
    }, 10_000);

    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', err => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
  });
}

interface JoinedAck {
  slideId: string;
  canBroadcast: boolean;
}

/**
 * Emit `join` for a slide room and wait until *this* socket's join has been
 * acknowledged.
 *
 * The server emits a per-socket `joined` ack on success, and a `join_error`
 * (with a `reason`) on every silent-reject path (slide not found, invalid
 * share code, non-member, unauthenticated). We resolve on `joined` and reject
 * fast on `join_error` — we deliberately do NOT resolve on `viewercount`,
 * which is a room-wide broadcast that another client's join can trigger and
 * which is never emitted on the reject paths (so it would hang the timeout).
 */
export function joinRoom(socket: Socket, slideId: string): Promise<JoinedAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out joining slide room ${slideId}`));
    }, 10_000);

    const onJoined = (payload: JoinedAck) => {
      cleanup();
      resolve(payload);
    };
    const onJoinError = (payload: { reason?: string }) => {
      cleanup();
      reject(new Error(`Server rejected join: ${payload?.reason ?? 'unknown'}`));
    };
    const onError = (payload: { message?: string }) => {
      cleanup();
      reject(new Error(`Server rejected join: ${payload?.message ?? 'unknown error'}`));
    };

    function cleanup() {
      clearTimeout(timer);
      socket.off('joined', onJoined);
      socket.off('join_error', onJoinError);
      socket.off('error', onError);
    }

    socket.once('joined', onJoined);
    socket.once('join_error', onJoinError);
    socket.once('error', onError);

    socket.emit('join', { slideId });
  });
}

/**
 * Wait for the next event of a given name, resolving with its payload.
 */
export function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 10_000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for socket event "${event}"`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Assert that a given event is NOT received within `windowMs`. Resolves if the
 * window elapses with no event, rejects if the event arrives. Used to prove
 * the server suppresses a broadcast (e.g. a follower's `slidechanged`) or that
 * room state was evicted (no `currentstate` on a fresh join).
 */
export function expectNoEvent(
  socket: Socket,
  event: string,
  windowMs = 1_500
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      reject(
        new Error(`Expected NO "${event}" but received: ${JSON.stringify(payload)}`)
      );
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, windowMs);
    socket.on(event, onEvent);
  });
}

/**
 * Cleanly disconnect a socket if it is still open.
 */
export function closeSocket(socket: Socket | null | undefined): void {
  if (socket && socket.connected) {
    socket.disconnect();
  } else if (socket) {
    socket.close();
  }
}
