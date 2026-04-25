import { useFetcher } from 'react-router';
import { requireAuth } from '@classmoji/auth/server';
import { notificationService } from '@classmoji/services';
import type { NotificationPreference } from '@prisma/client';
import type { Route } from './+types/route';

type EmailPrefKey = Extract<keyof NotificationPreference, `email_${string}`>;

interface PrefRow {
  key: EmailPrefKey;
  label: string;
  description?: string;
}

const STUDENT_PREFS: PrefRow[] = [
  { key: 'email_quiz_published', label: 'Quiz published' },
  { key: 'email_assignment_due_date_changed', label: 'Assignment due date changed' },
  { key: 'email_assignment_graded', label: 'Assignment graded' },
  { key: 'email_module_published', label: 'Module published' },
  { key: 'email_module_unpublished', label: 'Module unpublished' },
  { key: 'email_page_published', label: 'Page published' },
  { key: 'email_page_unpublished', label: 'Page unpublished' },
];

const TA_PREFS: PrefRow[] = [
  { key: 'email_ta_grading_assigned', label: 'Assigned to grade an assignment' },
  { key: 'email_ta_regrade_assigned', label: 'Assigned a regrade request' },
];

const ALLOWED_KEYS = new Set<EmailPrefKey>([...STUDENT_PREFS, ...TA_PREFS].map(p => p.key));

const isAllowedKey = (key: string): key is EmailPrefKey => (ALLOWED_KEYS as Set<string>).has(key);

export const loader = async ({ request }: Route.LoaderArgs) => {
  const { userId } = await requireAuth(request);
  const prefs = await notificationService.getPreferences(userId);
  return { prefs };
};

export const action = async ({ request }: Route.ActionArgs) => {
  const { userId } = await requireAuth(request);
  const formData = await request.formData();
  const key = String(formData.get('key') ?? '');
  const value = formData.get('value') === 'true';
  if (!isAllowedKey(key)) {
    return Response.json({ error: 'invalid key' }, { status: 400 });
  }
  await notificationService.updatePreferences(userId, { [key]: value });
  return Response.json({ ok: true });
};

const Toggle = ({
  prefKey,
  label,
  checked,
}: {
  prefKey: EmailPrefKey;
  label: string;
  checked: boolean;
}) => {
  const fetcher = useFetcher();
  const optimistic =
    fetcher.formData?.get('key') === prefKey ? fetcher.formData?.get('value') === 'true' : checked;

  return (
    <label className="flex items-center justify-between py-3 cursor-pointer border-b border-stone-100 dark:border-neutral-800 last:border-b-0">
      <span className="text-sm text-gray-800 dark:text-gray-200">{label}</span>
      <fetcher.Form method="post">
        <input type="hidden" name="key" value={prefKey} />
        <input type="hidden" name="value" value={String(!optimistic)} />
        <button
          type="submit"
          aria-pressed={optimistic}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            optimistic ? 'bg-violet-500' : 'bg-stone-300 dark:bg-neutral-700'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              optimistic ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </fetcher.Form>
    </label>
  );
};

const SettingsNotifications = ({ loaderData }: Route.ComponentProps) => {
  const prefs = loaderData.prefs;

  return (
    <div className="max-w-2xl">
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Choose which events you want to receive an email for. In-app notifications always appear in
        the bell on the home screen.
      </p>

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          As a student
        </h2>
        <div className="rounded-xl border border-stone-200 dark:border-neutral-800 px-4">
          {STUDENT_PREFS.map(p => (
            <Toggle key={p.key} prefKey={p.key} label={p.label} checked={Boolean(prefs[p.key])} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          As a teaching assistant
        </h2>
        <div className="rounded-xl border border-stone-200 dark:border-neutral-800 px-4">
          {TA_PREFS.map(p => (
            <Toggle key={p.key} prefKey={p.key} label={p.label} checked={Boolean(prefs[p.key])} />
          ))}
        </div>
      </section>
    </div>
  );
};

export default SettingsNotifications;
