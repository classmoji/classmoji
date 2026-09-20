import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad, waitForModal } from '../../helpers/wait.helpers';
import {
  deleteRepositoryById,
  getClassroomBySlug,
  getTestPrisma,
  seedRepositoryWithAssignment,
} from '../../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';

/**
 * Week view's two additions: a line where a deadline falls, and chips for
 * everything an event is linked to.
 *
 * The rows are written straight to the database rather than through the
 * authoring UI — this spec is about what the grid DRAWS, and it should not
 * depend on another suite having run first. Setup is idempotent (the repository
 * helper deletes any row with the same title before creating it, and the event
 * is deleted by title), and everything it makes is removed afterwards.
 *
 * Both fixtures are pinned to TODAY, so they are always in the week the
 * calendar opens on.
 */

const REPO_TITLE = 'PR5 Week Deadline';
const ASSIGNMENT_TITLE = 'PR5 Line Check';
const EVENT_TITLE = 'PR5 Linked Lecture';

let repositoryId: string;
let eventId: string;
let deckTitle: string;

const openWeek = async (page: Page, org: string): Promise<void> => {
  await page.goto(`/admin/${org}/calendar`);
  await waitForDataLoad(page, { anchor: page.getByRole('heading', { name: 'Calendar' }) });
  // The Week/Month choice persists in localStorage, so it is chosen rather
  // than assumed.
  await page.getByRole('button', { name: 'Week', exact: true }).click();
};

/** Today at a given local time — always inside the week the calendar opens on. */
const todayAt = (hour: number, minute: number): Date => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
};

test.beforeAll(async () => {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);

  // A deadline due at 11:59 PM: the case that widens the grid to midnight.
  const seeded = await seedRepositoryWithAssignment(classroom.id, REPO_TITLE, {
    assignmentTitle: ASSIGNMENT_TITLE,
  });
  repositoryId = seeded.repositoryId;
  await prisma.assignment.update({
    where: { id: seeded.assignmentId },
    data: { student_deadline: todayAt(23, 59) },
  });

  // A two-hour event, which is the tier that lists chips.
  const anyEvent = await prisma.calendarEvent.findFirst({
    where: { classroom_id: classroom.id },
    select: { created_by: true },
  });
  if (!anyEvent)
    throw new Error('No calendar events to borrow a creator from. Run `npm run db:seed`.');

  const deck = await prisma.slide.findFirst({
    where: { classroom_id: classroom.id, is_draft: false },
    select: { id: true, title: true },
    orderBy: { title: 'asc' },
  });
  if (!deck) throw new Error('Need a published slide deck. Run `npm run db:seed`.');
  deckTitle = deck.title;

  await prisma.calendarEvent.deleteMany({
    where: { classroom_id: classroom.id, title: EVENT_TITLE },
  });
  const event = await prisma.calendarEvent.create({
    data: {
      classroom_id: classroom.id,
      title: EVENT_TITLE,
      event_type: 'LECTURE',
      start_time: todayAt(13, 0),
      end_time: todayAt(15, 0),
      created_by: anyEvent.created_by,
      slideLinks: { create: [{ slide_id: deck.id, occurrence_date: null }] },
    },
  });
  eventId = event.id;
});

test.afterAll(async () => {
  const prisma = getTestPrisma();
  if (eventId) await prisma.calendarEvent.deleteMany({ where: { id: eventId } });
  if (repositoryId) await deleteRepositoryById(repositoryId);
});

test.describe('Owner Week View — deadline lines', () => {
  test('the grid draws an 11 PM row once something is due at 11:59 PM', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);
    // The window follows the day: without the late deadline the last row is
    // 10 PM, and the due line would have nowhere to land.
    await expect(page.getByText('11 PM', { exact: true }).first()).toBeVisible();
  });

  test('a deadline shows a labelled line at the time it is due', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);
    await expect(
      page.getByRole('button', { name: `Deadline: ${ASSIGNMENT_TITLE}, due 11:59 PM` })
    ).toBeVisible();
  });

  test('clicking the pill opens the same detail the all-day chip opens', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);
    await page.getByRole('button', { name: `Deadline: ${ASSIGNMENT_TITLE}, due 11:59 PM` }).click();

    const modal = await waitForModal(page, /Event Details/i);
    await expect(modal.getByText(ASSIGNMENT_TITLE).first()).toBeVisible();
    // Read-only in v1: rescheduling stays on the draggable all-day chip.
    await expect(modal.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  });

  test('the all-day chip stays, alongside the line', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);
    await expect(page.getByText('All day').first()).toBeVisible();
    await expect(page.getByText('due 11:59 PM').first()).toBeVisible();
  });
});

test.describe('Owner Week View — linked resources', () => {
  test('a linked deck shows as a chip on a two-hour event', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);
    await expect(page.getByText(EVENT_TITLE).first()).toBeVisible();
    await expect(page.getByRole('link', { name: `Open slide deck ${deckTitle}` })).toBeVisible();
  });

  test('clicking the chip opens the deck, not the event modal', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);

    const chip = page.getByRole('link', { name: `Open slide deck ${deckTitle}` });
    // Where it goes is asserted on the anchor itself; whether a new tab is
    // reported as a popup depends on `rel="noopener"` and is not the point.
    await expect(chip).toHaveAttribute('target', '_blank');

    const opened = page
      .context()
      .waitForEvent('page', { timeout: 5000 })
      .catch(() => null);
    await chip.click();
    const deckTab = await opened;

    // The press never reached the block underneath, which for an owner would
    // have opened the edit modal. dnd-kit's 3px sensor is listening on an
    // ancestor, so a wobbly click has to be stopped at the chip.
    await expect(page.locator('.ant-modal-content')).toHaveCount(0);
    if (deckTab) await deckTab.close();
  });
});
