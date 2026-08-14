/**
 * Pushes every template in ./templates.mjs to Resend and publishes it.
 *
 * Resend is the runtime source of truth, but this repo is the reviewable one.
 * Run this after editing templates.mjs so the two cannot drift:
 *
 *   RESEND_API_KEY=re_... node packages/services/src/emails/sync-templates.mjs
 *   RESEND_API_KEY=re_... node .../sync-templates.mjs --dry   # print, send nothing
 *
 * NOTE: this overwrites dashboard edits. If someone tweaks copy in the Resend
 * UI, mirror it back into templates.mjs or the next sync discards it.
 *
 * The key here must be FULL ACCESS. The app's own RESEND_API_KEY is send-only
 * (correct for runtime least-privilege) and returns 401 restricted_api_key on
 * every /templates route. Mint a separate management key for this script.
 */
import { Resend } from 'resend';
import { templates } from './templates.mjs';

const dry = process.argv.includes('--dry');
const apiKey = process.env.RESEND_API_KEY;

if (!apiKey && !dry) {
  console.error('RESEND_API_KEY is required (or pass --dry).');
  process.exit(1);
}

// Constructed lazily: the Resend constructor throws on a missing key, which
// would break --dry.
const resend = dry ? null : new Resend(apiKey);

// The SDK resolves with { data, error } instead of throwing, so every call is
// checked explicitly.
const check = (label, { data, error }) => {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
};

let failed = 0;

for (const t of templates) {
  if (dry) {
    console.log(`\n─── ${t.alias} ───`);
    console.log(`subject: ${t.subject}`);
    console.log(`vars   : ${t.variables.map(v => v.key).join(', ')}`);
    console.log(t.html);
    continue;
  }

  try {
    const existing = await resend.templates.get(t.alias);

    if (existing.error) {
      check(
        `create ${t.alias}`,
        await resend.templates.create({
          name: t.name,
          alias: t.alias,
          subject: t.subject,
          html: t.html,
          variables: t.variables,
        })
      );
      console.log(`created  ${t.alias}`);
    } else {
      check(
        `update ${t.alias}`,
        await resend.templates.update(t.alias, {
          name: t.name,
          subject: t.subject,
          html: t.html,
          variables: t.variables,
        })
      );
      console.log(`updated  ${t.alias}`);
    }

    // Drafts cannot send, and an update reverts a published template to draft.
    check(`publish ${t.alias}`, await resend.templates.publish(t.alias));
    console.log(`published ${t.alias}`);
  } catch (err) {
    failed += 1;
    console.error(`FAILED   ${t.alias}: ${err.message}`);
  }
}

if (failed > 0) process.exit(1);
