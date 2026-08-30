/**
 * Source of truth for every Resend-hosted email template.
 *
 * Resend hosts the versions that actually send; this file is what gets code
 * review. Run `node sync-templates.mjs` to push and publish.
 *
 * ── Escaping ────────────────────────────────────────────────────────────────
 * Resend does NOT escape template variables. Triple mustache is literal
 * injection: passing `<b>x</b>` as a variable renders live markup, verified
 * against the live API. Every user-controlled value MUST be escaped by the
 * caller before it becomes a variable. See escapeHtml in ./escape.ts.
 *
 * ── Client constraints ──────────────────────────────────────────────────────
 * Table layout (Outlook ignores max-width + margin auto on a div), inline
 * styles only (<style> gets stripped), longhand padding, bgcolor alongside
 * background-color, and no images.
 */

const FONT = "'Mona Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const GREEN = '#1f883d';
const INK = '#14151a';
const BODY_INK = '#2b2d35';
const MUTED = '#5b5f69';
const FAINT = '#8a8d97';
const HAIRLINE = '#e7e5e4';

const text = (content, { size = 15, lh = 24, color = BODY_INK, weight = 400, pb = 24 } = {}) =>
  `<tr>
              <td style="padding-bottom:${pb}px; font-family:${FONT}; font-size:${size}px; line-height:${lh}px; font-weight:${weight}; color:${color};">
                ${content}
              </td>
            </tr>`;

const heading = content => text(content, { size: 20, lh: 28, color: INK, weight: 600, pb: 12 });

const link = (href, label) =>
  `<a href="${href}" style="color:${GREEN}; text-decoration:underline;">${label}</a>`;

/** A primary action, rendered as a styled <a> in a <td> — never a <button>. */
const button = (href, label) =>
  `<tr>
              <td style="padding-bottom:28px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="${GREEN}" style="background-color:${GREEN}; border-radius:8px;">
                      <a href="${href}" style="display:inline-block; padding-top:11px; padding-right:20px; padding-bottom:11px; padding-left:20px; font-family:${FONT}; font-size:14px; line-height:20px; font-weight:600; color:#ffffff; text-decoration:none;">${label}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;

/** A quiet bordered box for codes, quotes, and grade strips. */
const box = (content, { size = 15, lh = 24, weight = 400, align = 'left', extra = '' } = {}) =>
  `<tr>
              <td style="padding-bottom:24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="${align}" bgcolor="#f6f8fa" style="background-color:#f6f8fa; border:1px solid ${HAIRLINE}; border-radius:8px; padding-top:16px; padding-right:16px; padding-bottom:16px; padding-left:16px; font-family:${FONT}; font-size:${size}px; line-height:${lh}px; font-weight:${weight}; color:${INK};${extra}">
                      ${content}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;

const footer = extraLine =>
  `<tr>
              <td style="border-top:1px solid ${HAIRLINE}; padding-top:20px; font-family:${FONT}; font-size:12px; line-height:20px; color:${MUTED};">
                ${extraLine ? `${extraLine}<br />` : ''}Need help, email us at ${link('mailto:hello@classmoji.io', 'hello@classmoji.io')}
                <br />
                <span style="font-size:12px; line-height:20px; color:${FAINT};">Made with ❤️ with support from ${link('https://dali.dartmouth.edu/', 'DALI')} and the ${link('https://web.cs.dartmouth.edu/', 'CS Department')} at Dartmouth College.</span>
              </td>
            </tr>`;

/** Wraps rows in the shared chrome. `preheader` is the inbox preview line. */
const shell = ({ title, preheader, rows, footerLine }) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light" />
    <title>${title}</title>
  </head>
  <body style="margin-top:0; margin-right:0; margin-bottom:0; margin-left:0; padding-top:0; padding-right:0; padding-bottom:0; padding-left:0; background-color:#ffffff;">
    <div style="display:none; font-size:1px; line-height:1px; color:#ffffff; max-height:0; max-width:0; opacity:0; overflow:hidden;">
      ${preheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background-color:#ffffff;">
      <tr>
        <td align="center" style="padding-top:40px; padding-right:20px; padding-bottom:40px; padding-left:20px;">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:520px;">
            ${rows.join('\n\n            ')}

            ${footer(footerLine)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

const PREFS_LINK = link('{{{PREFS_URL}}}', 'Manage email preferences');

export const templates = [
  {
    name: 'Verify Email',
    alias: 'verify-email',
    subject: '[Classmoji] Verify your school email',
    variables: [{ key: 'CODE', type: 'string' }],
    html: shell({
      title: 'Verify your email',
      preheader: 'Your verification code is {{{CODE}}} and expires in 10 minutes.',
      rows: [
        heading('Verify your email'),
        text('Enter this code to finish setting up your Classmoji account.'),
        box('{{{CODE}}}', {
          size: 30,
          lh: 38,
          weight: 700,
          align: 'center',
          extra: ' letter-spacing:8px; text-indent:8px;',
        }),
        text(
          'This code expires in 10 minutes. If you did not request it, you can safely ignore this email.',
          { size: 14, lh: 22, color: MUTED, pb: 28 }
        ),
      ],
    }),
  },

  {
    name: 'Notification',
    alias: 'notification',
    subject: '{{{SUBJECT}}}',
    // MESSAGE_HTML is a pre-rendered, already-escaped fragment carrying the
    // greeting too. Resend has no conditionals, so the 9 notification types all
    // resolve to one fragment upstream rather than branching here.
    variables: [
      { key: 'SUBJECT', type: 'string' },
      { key: 'PREHEADER', type: 'string', fallbackValue: 'You have a new Classmoji notification.' },
      { key: 'MESSAGE_HTML', type: 'string' },
      { key: 'MESSAGE_TEXT', type: 'string' },
      { key: 'ACTION_URL', type: 'string' },
      { key: 'PREFS_URL', type: 'string' },
    ],
    // Explicit text/plain. Resend derives text from the HTML *before* variable
    // substitution, so an auto-derived body would ship raw <p> markup from
    // MESSAGE_HTML into the plain part.
    text: `{{{MESSAGE_TEXT}}}

Open Classmoji: {{{ACTION_URL}}}

Manage email preferences: {{{PREFS_URL}}}
Need help, email us at hello@classmoji.io`,
    html: shell({
      title: 'Classmoji',
      preheader: '{{{PREHEADER}}}',
      rows: [text('{{{MESSAGE_HTML}}}', { pb: 28 }), button('{{{ACTION_URL}}}', 'Open Classmoji')],
      footerLine: PREFS_LINK,
    }),
  },

  {
    name: 'Roster — Added',
    alias: 'roster-added',
    subject: "[Classmoji] You've been added to {{{CLASSROOM_NAME}}}",
    variables: [
      { key: 'STUDENT_NAME', type: 'string', fallbackValue: 'there' },
      { key: 'CLASSROOM_NAME', type: 'string' },
      { key: 'APP_URL', type: 'string' },
    ],
    html: shell({
      title: 'You have been added to a classroom',
      preheader: 'You have been added to {{{CLASSROOM_NAME}}} on Classmoji.',
      rows: [
        heading('You have been added to {{{CLASSROOM_NAME}}}'),
        text('Hi {{{STUDENT_NAME}}}, you now have access to this classroom on Classmoji.'),
        button('{{{APP_URL}}}', 'Open your classroom'),
      ],
    }),
  },

  {
    name: 'Roster — Invited',
    alias: 'roster-invited',
    subject: "[Classmoji] You're invited to join {{{CLASSROOM_NAME}}}",
    variables: [
      { key: 'STUDENT_NAME', type: 'string', fallbackValue: 'there' },
      { key: 'CLASSROOM_NAME', type: 'string' },
      { key: 'APP_URL', type: 'string' },
    ],
    html: shell({
      title: 'You are invited to join a classroom',
      preheader: 'You have been invited to join {{{CLASSROOM_NAME}}} on Classmoji.',
      rows: [
        heading("You're invited to join {{{CLASSROOM_NAME}}}"),
        text(
          'Hi {{{STUDENT_NAME}}}, sign in to get started. Classmoji uses your Github account, so there is no new password to remember.'
        ),
        button('{{{APP_URL}}}', 'Join the classroom'),
      ],
    }),
  },

  {
    name: 'Form — Verify link',
    alias: 'form-verify-link',
    // "Confirm", not "verify": the recipient is finishing something they
    // started, not proving something about themselves. The form's title is in
    // the subject because someone who filled in three of these needs to know
    // which one this is.
    subject: '[Classmoji] Confirm your response to {{{FORM_TITLE}}}',
    // Every one of these is user-authored (a form title, a classroom name, a
    // name the filler typed about themselves) and Resend substitutes variables
    // RAW — `formResponse.service` runs them through `escapeVars` before they
    // get here. Keys are UPPERCASE to match what that service composes.
    variables: [
      { key: 'RECIPIENT_NAME', type: 'string', fallbackValue: 'there' },
      { key: 'FORM_TITLE', type: 'string' },
      { key: 'CLASSROOM_NAME', type: 'string' },
      { key: 'VERIFY_URL', type: 'string' },
      { key: 'EXPIRES_HOURS', type: 'string', fallbackValue: '48' },
    ],
    html: shell({
      title: 'Confirm your form response',
      preheader: 'Click to confirm your response to {{{FORM_TITLE}}}.',
      rows: [
        heading('Confirm your response'),
        text(
          'Hi {{{RECIPIENT_NAME}}}, you filled in <strong>{{{FORM_TITLE}}}</strong> for {{{CLASSROOM_NAME}}}. Open it to look your answers over and confirm them.'
        ),
        // Said plainly and BEFORE the button. Someone who assumes they are
        // already done will otherwise never find out that an unconfirmed
        // response is swept away after two days.
        text('Your response is not recorded until you do.', {
          size: 14,
          lh: 22,
          color: MUTED,
          pb: 20,
        }),
        button('{{{VERIFY_URL}}}', 'Review and confirm'),
        text(
          'This link works for {{{EXPIRES_HOURS}}} hours and can be used once. Later on, filling the form in again with the same address will email you a fresh link to the response you already have.',
          { size: 14, lh: 22, color: MUTED, pb: 8 }
        ),
        // A public form is a link anyone can share, so the recipient may
        // genuinely not have submitted anything — that has to be a real option,
        // and "ignore this" has to be the first thing the sentence says.
        text(
          'If you did not fill in this form, ignore this email. Nothing is recorded, and the entry disappears on its own.',
          { size: 14, lh: 22, color: MUTED, pb: 24 }
        ),
      ],
    }),
  },

  {
    name: 'Regrade — Requested',
    alias: 'regrade-requested',
    subject: '[Classmoji] Action required: Regrade requested',
    variables: [
      { key: 'STUDENT_NAME', type: 'string' },
      { key: 'STUDENT_LOGIN', type: 'string' },
      { key: 'ASSIGNMENT_TITLE', type: 'string' },
      { key: 'ISSUE_URL', type: 'string' },
      { key: 'PREVIOUS_GRADE', type: 'string', fallbackValue: '—' },
      { key: 'STUDENT_COMMENT', type: 'string', fallbackValue: 'None' },
    ],
    html: shell({
      title: 'Regrade requested',
      preheader: '{{{STUDENT_NAME}}} requested a regrade for {{{ASSIGNMENT_TITLE}}}.',
      rows: [
        heading('Regrade requested'),
        text(
          '{{{STUDENT_NAME}}} (@{{{STUDENT_LOGIN}}}) has requested a regrade for {{{ASSIGNMENT_TITLE}}}.',
          { pb: 16 }
        ),
        text('Previous grade: {{{PREVIOUS_GRADE}}}', { size: 14, lh: 22, color: MUTED, pb: 8 }),
        box('{{{STUDENT_COMMENT}}}', { size: 14, lh: 22 }),
        button('{{{ISSUE_URL}}}', 'Review the request'),
      ],
    }),
  },

  {
    name: 'Regrade — Resolved',
    alias: 'regrade-resolved',
    subject: '[Classmoji] Regrade request resolved',
    variables: [
      { key: 'ASSIGNMENT_TITLE', type: 'string' },
      { key: 'APP_URL', type: 'string' },
    ],
    html: shell({
      title: 'Regrade request resolved',
      preheader: 'Your regrade request for {{{ASSIGNMENT_TITLE}}} has been resolved.',
      rows: [
        heading('Regrade request resolved'),
        text(
          'Your regrade request for {{{ASSIGNMENT_TITLE}}} has been reviewed. Your updated grade is on your dashboard.',
          { pb: 28 }
        ),
        button('{{{APP_URL}}}', 'View your grade'),
      ],
    }),
  },

  {
    name: 'Extension — Status',
    alias: 'extension-status',
    // STATUS_LABEL is title-cased upstream; the raw enum is snake_case and
    // leaked into the old copy as "in_review".
    subject: '[Classmoji] Extension request {{{STATUS_LABEL}}}',
    variables: [
      { key: 'STUDENT_LOGIN', type: 'string' },
      { key: 'ASSIGNMENT_TITLE', type: 'string', fallbackValue: 'your assignment' },
      { key: 'STATUS_LABEL', type: 'string' },
      { key: 'APP_URL', type: 'string' },
    ],
    html: shell({
      title: 'Extension request update',
      preheader: 'Your extension request for {{{ASSIGNMENT_TITLE}}} was {{{STATUS_LABEL}}}.',
      rows: [
        heading('Extension request {{{STATUS_LABEL}}}'),
        text(
          'Hi @{{{STUDENT_LOGIN}}}, your extension request for {{{ASSIGNMENT_TITLE}}} was {{{STATUS_LABEL}}}.',
          { pb: 28 }
        ),
        button('{{{APP_URL}}}', 'Open Classmoji'),
      ],
    }),
  },
];
