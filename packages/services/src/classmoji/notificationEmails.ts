import type { NotificationType } from '@prisma/client';

const WEBAPP_URL = process.env.WEBAPP_URL ?? 'https://classmoji.com';

interface EmailContext {
  type: NotificationType;
  title: string;
  classroomName: string | null;
  resourceType: string;
  resourceId: string;
  recipientName: string | null;
  metadata?: Record<string, unknown>;
}

const SUBJECT_PREFIX = '[Classmoji]';

const subjectFor = (ctx: EmailContext): string => {
  const scope = ctx.classroomName ? ` ${ctx.classroomName}` : '';
  switch (ctx.type) {
    case 'QUIZ_PUBLISHED':
    case 'PAGE_PUBLISHED':
    case 'MODULE_PUBLISHED':
      return `${SUBJECT_PREFIX}${scope} - ${ctx.title}`;
    case 'PAGE_UNPUBLISHED':
    case 'MODULE_UNPUBLISHED':
      return `${SUBJECT_PREFIX}${scope} - ${ctx.title}`;
    case 'ASSIGNMENT_DUE_DATE_CHANGED':
      return `${SUBJECT_PREFIX}${scope} - Due date changed`;
    case 'ASSIGNMENT_GRADED':
      return `${SUBJECT_PREFIX}${scope} - Assignment graded`;
    case 'TA_GRADING_ASSIGNED':
      return `${SUBJECT_PREFIX}${scope} - New grading assignment`;
    case 'TA_REGRADE_ASSIGNED':
      return `${SUBJECT_PREFIX}${scope} - New regrade request`;
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

const bodyFor = (ctx: EmailContext): string => {
  const cls = ctx.classroomName ?? 'your classroom';
  switch (ctx.type) {
    case 'ASSIGNMENT_DUE_DATE_CHANGED': {
      const oldDate = formatDate(ctx.metadata?.previous_deadline);
      const newDate = formatDate(ctx.metadata?.new_deadline);
      return `<p>The due date for <strong>${escapeHtml(ctx.title)}</strong> in <strong>${escapeHtml(cls)}</strong> has changed.</p>${
        oldDate ? `<p>Previous: ${escapeHtml(oldDate)}</p>` : ''
      }${newDate ? `<p>New: <strong>${escapeHtml(newDate)}</strong></p>` : ''}`;
    }
    case 'ASSIGNMENT_GRADED':
      return `<p>Your submission for <strong>${escapeHtml(ctx.title)}</strong> in <strong>${escapeHtml(cls)}</strong> has been graded.</p>`;
    case 'TA_GRADING_ASSIGNED':
      return `<p>You've been assigned to grade <strong>${escapeHtml(ctx.title)}</strong> in <strong>${escapeHtml(cls)}</strong>.</p>`;
    case 'TA_REGRADE_ASSIGNED':
      return `<p>A regrade request for <strong>${escapeHtml(ctx.title)}</strong> in <strong>${escapeHtml(cls)}</strong> has been assigned to you.</p>`;
    default:
      return `<p><strong>${escapeHtml(ctx.title)}</strong> in <strong>${escapeHtml(cls)}</strong>.</p>`;
  }
};

const shell = (recipientName: string | null, body: string): string => {
  const greeting = recipientName ? `<p>Hi ${escapeHtml(recipientName)},</p>` : '';
  return `<div style="font-family:system-ui,-apple-system,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
    <div style="font-weight:600;font-size:18px;margin-bottom:16px">Classmoji</div>
    ${greeting}
    ${body}
    <p style="margin-top:24px;font-size:13px;color:#666">
      <a href="${WEBAPP_URL}/select-organization" style="color:#5b6cff">Open Classmoji</a>
      &nbsp;|&nbsp;
      <a href="${WEBAPP_URL}/settings/notifications" style="color:#666">Manage email preferences</a>
    </p>
  </div>`;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return replacements[c] ?? c;
  });

export const renderEmail = (ctx: EmailContext): { subject: string; html: string } => ({
  subject: subjectFor(ctx),
  html: shell(ctx.recipientName, bodyFor(ctx)),
});
