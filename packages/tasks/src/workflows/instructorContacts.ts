import { schedules, logger } from '@trigger.dev/sdk';
import { Resend } from 'resend';
import { listInstructorContacts, type InstructorContact } from '@classmoji/services';

/**
 * Reconcile the Resend "Instructors" segment against the instructors we have.
 *
 * A sweep rather than a hook on classroom creation: an OWNER membership is
 * minted in more than one place, and a missed hook fails silently.
 *
 * Additive only. It never updates or removes a contact already in the segment,
 * because re-writing one can flip `unsubscribed` back to false and mail someone
 * who opted out, and dropping one is a decision with a person behind it.
 */

// Bounds the blast radius of a misconfiguration. The remainder carries to
// tomorrow rather than aborting the run.
const MAX_ADDITIONS_PER_RUN = 100;

// Resend allows 2 requests/second. This job has all night, so it spaces its
// calls instead of handling 429s.
const REQUEST_SPACING_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface SyncConfig {
  apiKey: string;
  segmentId: string;
}

// Read at call time, not module load: a snapshot pins a stale value across a
// dev reload and makes the environment unmockable.
const readConfig = (env: NodeJS.ProcessEnv = process.env): SyncConfig | null => {
  const apiKey = (env.RESEND_API_KEY || '').trim();
  const segmentId = (env.RESEND_INSTRUCTORS_SEGMENT_ID || '').trim();
  if (!apiKey || !segmentId) return null;
  return { apiKey, segmentId };
};

/** Is instructor contact sync available in this process? */
export const isInstructorContactSyncConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  readConfig(env) !== null;

// Pages to exhaustion: the segment already exceeds one 100-item page, and an
// unpaged read would report most of it as missing and re-add it.
const listSegmentEmails = async (resend: Resend, segmentId: string): Promise<Set<string>> => {
  const emails = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const { data, error } = await resend.contacts.list({ segmentId, limit: 100, after });
    if (error) throw new Error(`Failed to list segment contacts: ${error.message}`);

    const page = data?.data ?? [];
    for (const contact of page) {
      if (contact.email) emails.add(contact.email.trim().toLowerCase());
    }

    if (!data?.has_more || page.length === 0) break;
    after = page[page.length - 1]?.id;
    if (!after) break;
    await sleep(REQUEST_SPACING_MS);
  }

  return emails;
};

// Checks for an existing contact first: one may already exist carrying
// `unsubscribed: true`, and creating over them resurrects the unsubscribe.
// `segments.add` moves them in and leaves the flag alone.
const addToSegment = async (
  resend: Resend,
  segmentId: string,
  contact: InstructorContact
): Promise<'created' | 'segmented'> => {
  const existing = await resend.contacts.get({ email: contact.email });

  if (existing.data?.id) {
    const { error } = await resend.contacts.segments.add({ email: contact.email, segmentId });
    if (error) throw new Error(`Failed to add ${contact.email} to segment: ${error.message}`);
    return 'segmented';
  }

  const { error } = await resend.contacts.create({
    email: contact.email,
    firstName: contact.firstName || undefined,
    lastName: contact.lastName || undefined,
    segments: [{ id: segmentId }],
  });
  if (error) throw new Error(`Failed to create contact ${contact.email}: ${error.message}`);
  return 'created';
};

export const syncInstructorContacts = schedules.task({
  id: 'sync-instructor-contacts',
  // 05:50 UTC daily, after the other nightly jobs and off the hour.
  cron: '50 5 * * *',
  run: async () => {
    const config = readConfig();
    if (!config) {
      logger.info('Instructor contact sync is not configured; skipping');
      return { skipped: true as const };
    }

    const resend = new Resend(config.apiKey);

    const [instructors, existing] = await Promise.all([
      listInstructorContacts(),
      listSegmentEmails(resend, config.segmentId),
    ]);

    const missing = instructors.filter(contact => !existing.has(contact.email));
    const batch = missing.slice(0, MAX_ADDITIONS_PER_RUN);
    const deferred = missing.length - batch.length;

    if (deferred > 0) {
      logger.warn('More instructors missing than one run adds; remainder carries to tomorrow', {
        missing: missing.length,
        cap: MAX_ADDITIONS_PER_RUN,
        deferred,
      });
    }

    let created = 0;
    let segmented = 0;
    const failures: string[] = [];

    for (const [index, contact] of batch.entries()) {
      try {
        const outcome = await addToSegment(resend, config.segmentId, contact);
        if (outcome === 'created') created += 1;
        else segmented += 1;
      } catch (error: unknown) {
        // One bad address must not cost the rest of the batch.
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${contact.email}: ${message}`);
        logger.error('Failed to add instructor to segment', { email: contact.email, message });
      }

      if (index < batch.length - 1) await sleep(REQUEST_SPACING_MS);
    }

    logger.info('Instructor contact sync complete', {
      instructors: instructors.length,
      alreadyInSegment: existing.size,
      created,
      segmented,
      failed: failures.length,
      deferred,
    });

    return {
      instructors: instructors.length,
      alreadyInSegment: existing.size,
      created,
      segmented,
      failed: failures.length,
      deferred,
      failures,
    };
  },
});
