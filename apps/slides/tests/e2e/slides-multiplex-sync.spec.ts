/**
 * Slides Multiplex (Socket.IO) Sync E2E Tests
 *
 * User stories covered:
 *  - When a presenter changes slides, followers in the same room receive the
 *    same slidechanged event in real time (two independent socket clients).
 *  - A public follower joining with a valid shareCode receives the presenter's
 *    slide changes.
 *  - A follower joining with an INVALID shareCode is rejected and never syncs.
 *
 * These exercise the `/multiplex` Socket.IO namespace in apps/slides/server.ts.
 * We use raw Socket.IO clients (tests/helpers/socket.ts) rather than two reveal
 * browsers so the broadcast/receive handshake is observed deterministically
 * without arbitrary timeouts or page.evaluate state mutation.
 *
 * Auth model (server.ts):
 *  - OWNER/TEACHER members (session cookie) may broadcast `slidechanged`.
 *  - shareCode followers may join (must equal slide.multiplex_id) but cannot
 *    broadcast.
 */

import { test, expect } from '../fixtures/test.fixture';
import { Socket } from 'socket.io-client';
import { loginAs, createSlide, deleteSlide, getTestClassroomSlug } from '../helpers';
import {
  connectMultiplex,
  joinRoom,
  waitForEvent,
  expectNoEvent,
  closeSocket,
  cookieHeaderFromContext,
  type SlideChangedEvent,
} from '../helpers/socket';
import {
  getSlideById,
  getClassroomIdBySlug,
  ensureSlideShareCode,
} from '../helpers/prisma.helpers';

test.describe.configure({ mode: 'serial' });

let testSlideId: string;
let ownerCookie: string;
let studentCookie: string;
let shareCode: string;

// Unique per run so parallel/repeat runs never collide on the same deck title.
const TEST_RUN_ID = `multiplex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SYNC_DECK_TITLE = `Sync Deck ${TEST_RUN_ID}`;

test.describe('Slides real-time multiplex sync', () => {
  test('setup: instructor creates a deck and enables sharing', async ({ page }) => {
    await loginAs(page, 'owner');
    testSlideId = await createSlide(page, SYNC_DECK_TITLE);

    const row = await getSlideById(testSlideId);
    expect(row).not.toBeNull();
    const classroomId = await getClassroomIdBySlug(getTestClassroomSlug());
    expect(row?.classroom_id).toBe(classroomId);

    // Reuse the owner session cookie so Node socket clients can broadcast.
    ownerCookie = await cookieHeaderFromContext(page.context());
    expect(ownerCookie).toContain('classmoji.session_token');

    shareCode = await ensureSlideShareCode(testSlideId);
    const shared = await getSlideById(testSlideId);
    expect(shared?.multiplex_id).toBe(shareCode);
  });

  test('setup: capture a student session cookie', async ({ page }) => {
    await loginAs(page, 'student');
    studentCookie = await cookieHeaderFromContext(page.context());
    expect(studentCookie).toContain('classmoji.session_token');
  });

  test('a presenter slide change is delivered to a second client in the same room', async () => {
    let presenter: Socket | null = null;
    let follower: Socket | null = null;
    try {
      // Both clients authenticate as OWNER so both are allowed in the room.
      presenter = await connectMultiplex({ cookieHeader: ownerCookie });
      follower = await connectMultiplex({ cookieHeader: ownerCookie });

      await joinRoom(presenter, testSlideId);
      await joinRoom(follower, testSlideId);

      // Arm the follower's listener before the presenter broadcasts.
      const received = waitForEvent<SlideChangedEvent>(follower, 'slidechanged');

      presenter.emit('slidechanged', { indexh: 1, indexv: 0 });

      const event = await received;
      expect(event.indexh).toBe(1);
      expect(event.indexv).toBe(0);
    } finally {
      closeSocket(presenter);
      closeSocket(follower);
    }
  });

  test('a public shareCode follower receives the presenter slide change', async () => {
    let presenter: Socket | null = null;
    let follower: Socket | null = null;
    try {
      // Presenter authenticates via cookie; follower joins publicly via shareCode.
      presenter = await connectMultiplex({ cookieHeader: ownerCookie });
      follower = await connectMultiplex({ shareCode });

      await joinRoom(presenter, testSlideId);
      await joinRoom(follower, testSlideId);

      const received = waitForEvent<SlideChangedEvent>(follower, 'slidechanged');
      presenter.emit('slidechanged', { indexh: 2, indexv: 0 });

      const event = await received;
      expect(event.indexh).toBe(2);
      expect(event.indexv).toBe(0);
    } finally {
      closeSocket(presenter);
      closeSocket(follower);
    }
  });

  test('a follower with an invalid shareCode is rejected from the room', async () => {
    let follower: Socket | null = null;
    try {
      // The connect succeeds, but the join is rejected because the code does not
      // match slide.multiplex_id.
      follower = await connectMultiplex({ shareCode: 'totally-wrong-code' });

      await expect(joinRoom(follower, testSlideId)).rejects.toThrow(/Invalid share code/i);
    } finally {
      closeSocket(follower);
    }
  });

  test('joining a non-existent slide id rejects fast (not a timeout)', async () => {
    let client: Socket | null = null;
    try {
      client = await connectMultiplex({ cookieHeader: ownerCookie });
      // A syntactically valid but non-existent id: the server emits `join_error`
      // with reason `slide_not_found`, so joinRoom rejects immediately instead
      // of hanging the full timeout.
      await expect(joinRoom(client, 'does-not-exist-slide-id')).rejects.toThrow(
        /slide_not_found/i
      );
    } finally {
      closeSocket(client);
    }
  });

  test('late joiner catches up via currentstate, and state is evicted after the last viewer leaves', async () => {
    // Phase 1: presenter sets slide position; a late follower must receive it.
    let presenter: Socket | null = null;
    let lateFollower: Socket | null = null;
    try {
      presenter = await connectMultiplex({ cookieHeader: ownerCookie });
      await joinRoom(presenter, testSlideId);

      presenter.emit('slidechanged', { indexh: 3, indexv: 0 });
      // Give the server a beat to persist the room state before the late join.
      await new Promise(r => setTimeout(r, 250));

      lateFollower = await connectMultiplex({ shareCode });
      const catchUp = waitForEvent<SlideChangedEvent>(lateFollower, 'currentstate');
      await joinRoom(lateFollower, testSlideId);

      const state = await catchUp;
      expect(state.indexh).toBe(3);
    } finally {
      closeSocket(presenter);
      closeSocket(lateFollower);
    }

    // Allow the disconnects to propagate so the room empties and state evicts.
    await new Promise(r => setTimeout(r, 500));

    // Phase 2: with all viewers gone, a fresh follower must receive NO
    // currentstate — proving releaseIfEmpty evicted the stored position.
    let reFollower: Socket | null = null;
    try {
      reFollower = await connectMultiplex({ shareCode });
      const noState = expectNoEvent(reFollower, 'currentstate');
      await joinRoom(reFollower, testSlideId);
      await noState;
    } finally {
      closeSocket(reFollower);
    }
  });

  test('a shareCode follower cannot broadcast slidechanged to the presenter', async () => {
    let presenter: Socket | null = null;
    let follower: Socket | null = null;
    try {
      presenter = await connectMultiplex({ cookieHeader: ownerCookie });
      follower = await connectMultiplex({ shareCode });

      await joinRoom(presenter, testSlideId);
      await joinRoom(follower, testSlideId);

      // Arm the presenter's listener, then have the follower attempt a
      // broadcast. server.ts drops it (`if (!data.canBroadcast) return`).
      const noBroadcast = expectNoEvent(presenter, 'slidechanged');
      follower.emit('slidechanged', { indexh: 9, indexv: 9 });
      await noBroadcast;
    } finally {
      closeSocket(presenter);
      closeSocket(follower);
    }
  });

  test('a STUDENT member cannot broadcast slidechanged (canBroadcast=false)', async () => {
    let presenter: Socket | null = null;
    let student: Socket | null = null;
    try {
      presenter = await connectMultiplex({ cookieHeader: ownerCookie });
      // Student is a classroom member (so join succeeds) but role STUDENT, so
      // the server sets canBroadcast=false and drops their slidechanged.
      student = await connectMultiplex({ cookieHeader: studentCookie });

      await joinRoom(presenter, testSlideId);
      await joinRoom(student, testSlideId);

      const noBroadcast = expectNoEvent(presenter, 'slidechanged');
      student.emit('slidechanged', { indexh: 7, indexv: 1 });
      await noBroadcast;
    } finally {
      closeSocket(presenter);
      closeSocket(student);
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!testSlideId) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await loginAs(page, 'owner');
      await deleteSlide(page, testSlideId);
    } catch (e) {
      console.error('Cleanup failed:', e);
    } finally {
      await context.close();
    }
  });
});
