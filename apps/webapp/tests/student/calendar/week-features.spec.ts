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
 * The same two week-view additions, from a student's side — which is the half
 * that matters: an instructor assumes their class sees what they see, and the
 * two calendars are now one set of components precisely so that is true.
 *
 * The repository and the assignment are PUBLISHED, so a student is served the
 * deadline at all; the deck is not a draft, for the same reason. Rows are
 * written straight to the database and removed afterwards.
 */

const REPO_TITLE = 'PR5 Student Week Deadline';
const ASSIGNMENT_TITLE = 'PR5 Student Line Check';
const EVENT_TITLE = 'PR5 Student Linked Lecture';

let repositoryId: string;
let eventId: string;
let deckTitle: string;

const openWeek = async (page: Page, org: string): Promise<void> => {
  await page.goto(`/student/${org}/calendar`);
  await waitForDataLoad(page, { anchor: page.getByRole('heading', { name: 'Calendar' }) });
  await page.getByRole('button', { name: 'Week', exact: true }).click();
};

const todayAt = (hour: number, minute: number): Date => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
};

test.beforeAll(async () => {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);

  const seeded = await seedRepositoryWithAssignment(classroom.id, REPO_TITLE, {
    assignmentTitle: ASSIGNMENT_TITLE,
  });
  repositoryId = seeded.repositoryId;
  await prisma.assignment.update({
    where: { id: seeded.assignmentId },
    data: { student_deadline: todayAt(23, 59) },
  });

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

test.describe('Student Week View — deadline lines', () => {
  test('the grid draws an 11 PM row once something is due at 11:59 PM', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);
    await expect(page.getByText('11 PM', { exact: true }).first()).toBeVisible();
  });

  test('a deadline shows a labelled line at the time it is due', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);
    // The whole point of the feature: the due time is readable without
    // clicking the chip at the top of the screen to find it.
    await expect(
      page.getByRole('button', { name: `Deadline: ${ASSIGNMENT_TITLE}, due 11:59 PM` })
    ).toBeVisible();
  });

  test('clicking the pill opens the read-only detail', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await openWeek(page, testOrg);
    await page.getByRole('button', { name: `Deadline: ${ASSIGNMENT_TITLE}, due 11:59 PM` }).click();

    const modal = await waitForModal(page, /Event Details/i);
    await expect(modal.getByText(ASSIGNMENT_TITLE).first()).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  });
});

test.describe('Student Week View — linked resources', () => {
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
    await expect(chip).toHaveAttribute('target', '_blank');

    const opened = page
      .context()
      .waitForEvent('page', { timeout: 5000 })
      .catch(() => null);
    await chip.click();
    const deckTab = await opened;

    await expect(page.locator('.ant-modal-content')).toHaveCount(0);
    if (deckTab) await deckTab.close();
  });
});
