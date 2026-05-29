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
let shareCode: string;

const TEST_RUN_ID = 'multiplex';
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
