import type { NotificationType } from '@prisma/client';
import { appUrl, escapeHtml } from '../emails/escape.ts';

interface EmailContext {
  type: NotificationType;
  title: string;
  classroomName: string | null;
  resourceType: string;
  resourceId: string;
  recipientName: string | null;
  metadata?: Record<string, unknown>;
}

/** Variables for the Resend template with alias `notification`. */
export interface NotificationEmail {
  template: {
    id: 'notification';
    variables: {
      SUBJECT: string;
      PREHEADER: string;
      MESSAGE_HTML: string;
      MESSAGE_TEXT: string;
      ACTION_URL: string;
      PREFS_URL: string;
    };
  };
}

const SUBJECT_PREFIX = '[Classmoji]';

const subjectFor = (ctx: EmailContext): string => {
  const scope = ctx.classroomName ? ` ${ctx.classroomName}` : '';
  switch (ctx.type) {
    case 'ASSIGNMENT_DUE_DATE_CHANGED':
      return `${SUBJECT_PREFIX}${scope} - Due date changed`;
    case 'ASSIGNMENT_GRADED':
      return `${SUBJECT_PREFIX}${scope} - Assignment graded`;
    case 'TA_GRADING_ASSIGNED':
      return `${SUBJECT_PREFIX}${scope} - New grading assignment`;
    case 'TA_REGRADE_ASSIGNED':
      return `${SUBJECT_PREFIX}${scope} - New regrade request`;
    default:
      // QUIZ_PUBLISHED, PAGE_(UN)PUBLISHED, REPOSITORY_(UN)PUBLISHED — the verb
      // is carried in `title` by the caller. A default also means a new enum
      // member can no longer produce the literal subject "undefined".
      return `${SUBJECT_PREFIX}${scope} - ${ctx.title}`;
  }
};

const formatDate = (value: unknown): string | null => {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/**
 * The message as one plain sentence, with nothing escaped. Used for the
 * text/plain alternative, where entities would render literally as "&lt;".
 */
const sentenceFor = (ctx: EmailContext): string => {
  const cls = ctx.classroomName ?? 'your classroom';
  switch (ctx.type) {
    case 'ASSIGNMENT_DUE_DATE_CHANGED':
      return `The due date for ${ctx.title} in ${cls} has changed.`;
    case 'ASSIGNMENT_GRADED':
      return `Your submission for ${ctx.title} in ${cls} has been graded.`;
    case 'TA_GRADING_ASSIGNED':
      return `You have been assigned to grade ${ctx.title} in ${cls}.`;
    case 'TA_REGRADE_ASSIGNED':
      return `A regrade request for ${ctx.title} in ${cls} has been assigned to you.`;
    default:
      return `${ctx.title} in ${cls}.`;
  }
};

/**
 * The message body, pre-rendered into a single already-escaped HTML fragment.
 * Resend templates have no conditionals, so all nine notification types resolve
 * here rather than branching in the template.
 */
const bodyFor = (ctx: EmailContext): string => {
  const cls = escapeHtml(ctx.classroomName ?? 'your classroom');
  const title = escapeHtml(ctx.title);

  switch (ctx.type) {
    case 'ASSIGNMENT_DUE_DATE_CHANGED': {
      const oldDate = formatDate(ctx.metadata?.previous_deadline);
      const newDate = formatDate(ctx.metadata?.new_deadline);
      return `<p style="margin-top:0;">The due date for <strong>${title}</strong> in <strong>${cls}</strong> has changed.</p>${
        oldDate ? `<p>Previous: ${escapeHtml(oldDate)}</p>` : ''
      }${newDate ? `<p style="margin-bottom:0;">New: <strong>${escapeHtml(newDate)}</strong></p>` : ''}`;
    }
    case 'ASSIGNMENT_GRADED':
      return `<p style="margin-top:0; margin-bottom:0;">Your submission for <strong>${title}</strong> in <strong>${cls}</strong> has been graded.</p>`;
    case 'TA_GRADING_ASSIGNED':
      return `<p style="margin-top:0; margin-bottom:0;">You've been assigned to grade <strong>${title}</strong> in <strong>${cls}</strong>.</p>`;
    case 'TA_REGRADE_ASSIGNED':
      return `<p style="margin-top:0; margin-bottom:0;">A regrade request for <strong>${title}</strong> in <strong>${cls}</strong> has been assigned to you.</p>`;
    default:
      return `<p style="margin-top:0; margin-bottom:0;"><strong>${title}</strong> in <strong>${cls}</strong>.</p>`;
  }
};

export const renderEmail = (ctx: EmailContext): NotificationEmail => {
  const greetingHtml = ctx.recipientName
    ? `<p style="margin-top:0;">Hi ${escapeHtml(ctx.recipientName)},</p>`
    : '';
  const greetingText = ctx.recipientName ? `Hi ${ctx.recipientName},\n\n` : '';
  const sentence = sentenceFor(ctx);

  return {
    template: {
      id: 'notification',
      variables: {
        // Subject is a mail header, not HTML — escaping it would surface
        // literal "&amp;" in the inbox.
        SUBJECT: subjectFor(ctx),
        // Lands in a hidden <div>, so it is escaped.
        PREHEADER: escapeHtml(sentence),
        MESSAGE_HTML: `${greetingHtml}${bodyFor(ctx)}`,
        // The template supplies its own text/plain body from this. Without it
        // Resend derives text from the HTML before substitution and leaks raw
        // <p> tags into the plain part.
        MESSAGE_TEXT: `${greetingText}${sentence}`,
        ACTION_URL: `${appUrl()}/select-organization`,
        PREFS_URL: `${appUrl()}/settings/notifications`,
      },
    },
  };
};
