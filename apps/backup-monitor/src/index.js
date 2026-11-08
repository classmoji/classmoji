import { assess, newestBackup } from './check.js';

/**
 * Daily check that the production database backup ran (README.md). It lives
 * on Cloudflare, not Trigger.dev, so it still alerts if Trigger itself stops
 * running the backup.
 *
 * Bindings: BACKUPS (R2, classmoji-db-backups-prod, read only by this code).
 * Secrets: RESEND_API_KEY, ALERT_EMAIL (comma-separated). Var: ALERT_FROM.
 */

async function listObjects(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ cursor });
    for (const object of page.objects) objects.push({ key: object.key, size: object.size });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function check(env, now) {
  return assess({ backup: newestBackup(await listObjects(env.BACKUPS)), now });
}

async function alert(env, problem) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) {
    // Unconfigured alerts must still fail loudly in the Worker's logs.
    throw new Error(
      `backup-monitor: cannot send alert (RESEND_API_KEY/ALERT_EMAIL unset): ${problem}`
    );
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.ALERT_FROM || 'Classmoji <hello@classmoji.io>',
      to: env.ALERT_EMAIL.split(',')
        .map(s => s.trim())
        .filter(Boolean),
      subject: 'Classmoji database backup is missing',
      text:
        `${problem}\n\n` +
        'Check the db-backup task in the Trigger.dev production environment, then the bucket ' +
        'classmoji-db-backups-prod. Runbook: docs/db-backups.md in the classmoji repo.',
    }),
  });
  if (!response.ok) {
    throw new Error(`backup-monitor: Resend answered ${response.status}: ${await response.text()}`);
  }
}

export default {
  async scheduled(_controller, env) {
    const result = await check(env, new Date());
    if (result.ok) {
      // eslint-disable-next-line no-console -- the one success line in the Worker logs
      console.log(`backup ok: ${result.key}, ${result.ageHours.toFixed(1)}h old`);
      return;
    }
    console.error(`backup problem: ${result.problem}`);
    await alert(env, result.problem);
  },
};
