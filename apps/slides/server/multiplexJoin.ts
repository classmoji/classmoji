import { reportError } from '@classmoji/utils/error-report';

/** What the join handler reads and writes on the socket's own data. */
export interface JoinSocketData {
  user?: {
    login: string | null;
    classroom_memberships: Array<{ role: string; classroom: { id: string } | null }>;
  };
  slideId?: string;
  canBroadcast?: boolean;
  shareCode?: string;
}

/** The slide fields a join reads. */
export interface JoinSlide {
  classroom_id: string;
  multiplex_id: string | null;
}

export interface JoinDeps {
  socket: { emit(event: string, payload?: unknown): unknown; join(room: string): unknown };
  data: JoinSocketData;
  findSlide(id: string): Promise<JoinSlide | null>;
  currentState(slideId: string): { indexh: number; indexv: number } | undefined;
  roomSize(slideId: string): number;
  broadcastViewerCount(slideId: string, count: number): void;
}

/**
 * The slide id a `join` payload names, or null when it names none: the
 * payload is client input (any JSON value, or nothing), so only an object
 * whose `slideId` is a string is a request to join.
 */
export function joinSlideId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const slideId = (payload as { slideId?: unknown }).slideId;
  return typeof slideId === 'string' ? slideId : null;
}

/**
 * The multiplex `join` listener. The payload is validated before anything
 * is looked up: one that names no slide id is logged and answered as it
 * always was (no event back), with no query and nothing reported. For a
 * slide id, every failure is logged and reported (Socket.IO events run
 * outside any HTTP request, so nothing else would report them).
 */
export function createJoinHandler(deps: JoinDeps): (payload: unknown) => Promise<void> {
  const { socket, data } = deps;
  return async payload => {
    const slideId = joinSlideId(payload);
    if (slideId === null) {
      console.error('[multiplex] Join error: the payload names no slide id');
      return;
    }
    try {
      const slide = await deps.findSlide(slideId);

      if (!slide) {
        console.log(`[multiplex] Slide ${slideId} not found`);
        socket.emit('join_error', { reason: 'slide_not_found' });
        return;
      }

      // Check authorization
      if (data.shareCode) {
        // Validate shareCode against slide's multiplex_id
        if (slide.multiplex_id !== data.shareCode) {
          console.log(`[multiplex] Invalid shareCode for slide ${slideId}`);
          socket.emit('error', { message: 'Invalid share code' });
          socket.emit('join_error', { reason: 'invalid_share_code' });
          return;
        }
        // Public follower - can join but not broadcast
        data.canBroadcast = false;
      } else if (data.user) {
        // Authenticated user - verify classroom membership
        const membership = data.user.classroom_memberships.find(
          m => String(m.classroom?.id) === String(slide.classroom_id)
        );

        if (!membership) {
          console.log(
            `[multiplex] User ${data.user.login} not a member of classroom ${slide.classroom_id}`
          );
          socket.emit('join_error', { reason: 'not_a_member' });
          return;
        }

        data.canBroadcast = membership.role === 'OWNER' || membership.role === 'TEACHER';
      } else {
        // No auth at all
        socket.emit('join_error', { reason: 'unauthenticated' });
        return;
      }

      socket.join(slideId);
      data.slideId = slideId;

      // Per-socket ack so clients can resolve their own join deterministically
      // (the room-wide `viewercount` below can be triggered by other clients).
      socket.emit('joined', { slideId, canBroadcast: data.canBroadcast });

      console.log(
        `[multiplex] ${data.user?.login || 'anonymous'} joined ${slideId} (canBroadcast: ${data.canBroadcast})`
      );

      // Send current slide position to late joiner (catch-up)
      const currentState = deps.currentState(slideId);
      if (currentState) {
        console.log(
          `[multiplex] Sending current state to late joiner: h=${currentState.indexh}, v=${currentState.indexv}`
        );
        socket.emit('currentstate', currentState);
      }

      // Broadcast updated viewer count
      deps.broadcastViewerCount(slideId, deps.roomSize(slideId));
    } catch (err) {
      console.error('[multiplex] Join error:', err);
      reportError(err, { surface: 'slides.multiplex.join' });
    }
  };
}
