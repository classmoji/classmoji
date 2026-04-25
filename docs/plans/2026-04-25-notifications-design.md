# Notifications Design - 2026-04-25

## Scope

Classmoji notifications ship in two channels:

- In-app notifications in the bell on `/select-organization`
- Email notifications, controlled by per-user preferences

Notifications are fetched on page load. There is no real-time push in v1.

## Events

Student-facing notifications:

- `QUIZ_PUBLISHED`
- `PAGE_PUBLISHED`
- `PAGE_UNPUBLISHED`
- `MODULE_PUBLISHED`
- `MODULE_UNPUBLISHED`
- `ASSIGNMENT_DUE_DATE_CHANGED`
- `ASSIGNMENT_GRADED`

Teaching-assistant notifications:

- `TA_GRADING_ASSIGNED`
- `TA_REGRADE_ASSIGNED`

Instructor notifications are out of scope for v1.

## Behavior

- The bell aggregates notifications across all of a user's classrooms.
- Unread count is shown in the bell badge.
- Row click marks the notification read and navigates to the best role-specific route.
- Rows can be dismissed.
- "Mark all as read" marks all of the user's notifications read.
- Notifications expire after 30 days and are deleted by a daily Trigger.dev schedule.
- Notification failures are logged and swallowed so they do not break the primary action.
- Duplicate recipient IDs are deduped before rows or email tasks are created.

## Data Model

`Notification` stores one row per recipient/event, scoped by `user_id` and optionally by `classroom_id`.

`NotificationPreference` stores email preferences for each supported notification type. In-app notifications always appear regardless of email preference.

The Prisma schema and migration live in:

- `packages/database/schema.prisma`
- `packages/database/migrations/20260425184214_add_notifications/migration.sql`

## Service Layer

Main implementation:

- `packages/services/src/classmoji/notification.service.ts`
- `packages/services/src/classmoji/notificationEmails.ts`

Key service functions:

- `createNotifications(...)`
- `getForBell(userId, limit)`
- `markRead(userId, ids)`
- `markAllRead(userId)`
- `dismiss(userId, ids)`
- `getPreferences(userId)`
- `updatePreferences(userId, patch)`

## Web Routes

- `_user.select-organization` loader returns notifications, unread count, and membership roles.
- `api.notifications.read` marks selected or all notifications read.
- `api.notifications.dismiss` deletes selected notifications owned by the current user.
- `_user.settings.notifications` lets users update email preferences.

## Cleanup

`packages/tasks/src/workflows/notifications.ts` deletes expired notification rows daily at 03:15 UTC.
