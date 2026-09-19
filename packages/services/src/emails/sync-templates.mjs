/**
 * Pushes every template in ./templates.mjs to Resend and publishes it.
 *
 * Resend is the runtime source of truth, but this repo is the reviewable one.
 * Run this after editing templates.mjs so the two cannot drift:
 *
 *   RESEND_API_KEY=re_... node packages/services/src/emails/sync-templates.mjs
 *   RESEND_API_KEY=re_... node .../sync-templates.mjs --dry   # print, send nothing
 *   RESEND_API_KEY=re_... node .../sync-templates.mjs --only form-verify-link
 *
 * NOTE: this overwrites dashboard edits. If someone tweaks copy in the Resend
 * UI, mirror it back into templates.mjs or the next sync discards it.
 *
 * `--only` narrows that blast radius to the aliases you name (repeat the flag,
 * or pass one comma-separated list). Reach for it when you are adding a single
 * template and do not want to answer for every other one in the file. An alias
 * that matches nothing is an error rather than a silent no-op — a typo must not
 * look like a successful run that pushed nothing.
 *
 * The key here must be FULL ACCESS. The app's own RESEND_API_KEY is send-only
 * (correct for runtime least-privilege) and returns 401 restricted_api_key on
 * every /templates route. Mint a separate management key for this script.
 */
import { Resend } from 'resend';
import { templates } from './templates.mjs';

const dry = process.argv.includes('--dry');
const apiKey = process.env.RESEND_API_KEY;

/** Aliases named by `--only a --only b` and/or `--only a,b`. Empty means all. */
const only = new Set(
  process.argv
    .flatMap((arg, i) => (arg === '--only' ? [process.argv[i + 1]] : []))
    .filter(Boolean)
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
);

const selected = only.size ? templates.filter(t => only.has(t.alias)) : templates;

// A typo must not read as "synced everything you asked for" when it pushed
// nothing at all.
const unknown = [...only].filter(alias => !templates.some(t => t.alias === alias));
if (unknown.length) {
  console.error(`Unknown template alias: ${unknown.join(', ')}`);
  console.error(`Known aliases: ${templates.map(t => t.alias).join(', ')}`);
  process.exit(1);
}

if (!apiKey && !dry) {
  console.error('RESEND_API_KEY is required (or pass --dry).');
  process.exit(1);
}

if (only.size) console.log(`Syncing ${selected.length} of ${templates.length} templates.`);

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

for (const t of selected) {
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
