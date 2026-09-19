import { useEffect, useState } from 'react';
import { redirect, useFetcher, useNavigate, useParams } from 'react-router';
import { IconX } from '@tabler/icons-react';

import { ClassmojiService } from '~/utils/db.server.ts';
import { assertFormAdmin, formMutationBlocked } from '~/utils/formAuth.server.ts';
import { FORM_PRESETS, presetByKey, type FormAccessMode } from '~/components/forms/presets.ts';

/**
 * The New Form drawer — a child route of the list, so the table stays behind it
 * and the drawer has a URL of its own (`/{class}/forms/new`, refreshable and
 * linkable).
 *
 * Two decisions are made here and only here:
 *
 *  - ACCESS. It is a required choice at creation because `form.service` freezes
 *    it the moment the form leaves DRAFT: responses collected under
 *    email-identity and responses collected under session-identity cannot be
 *    mixed in one set. Presenting it as an afterthought in the builder would
 *    make the freeze feel arbitrary.
 *  - THE TEMPLATE. A preset is just a starting field list; nothing about the
 *    form remembers it afterwards.
 *
 * The preset's fields are built SERVER-side from a key, not posted by the
 * client. The client sending a field list would work — `create` validates
 * whatever it is handed — but then "Waitlist" would mean whatever the browser
 * decided it meant, and a stale tab could create a form from last month's
 * template.
 */

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  // The child route gates too. It is reachable directly by URL, and its action
  // is a create endpoint.
  await assertFormAdmin(params.classroomSlug!, request, { action: 'new_form' });
  return {
    presets: FORM_PRESETS.map(
      ({ key, label, blurb, access, requiresClassroom, suggestedTitle }) => ({
        key,
        label,
        blurb,
        access,
        requiresClassroom,
        suggestedTitle,
      })
    ),
  };
};

export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const classroomSlug = params.classroomSlug!;
  const { classroom, userId, membership } = await assertFormAdmin(classroomSlug, request, {
    action: 'create_form',
  });

  const blocked = formMutationBlocked(classroom, membership.role);
  if (blocked) return blocked;

  const body = (await request.json()) as {
    title?: string;
    access?: FormAccessMode;
    preset?: string;
  };

  const title = (body.title ?? '').trim();
  if (!title) return { error: 'Give the form a title.' };

  const preset = presetByKey(body.preset ?? 'blank');
  // A preset whose fields are classroom-only decides the mode; otherwise the
  // instructor's choice stands. Either way `create` re-checks the field list
  // against the mode server-side and refuses a mismatch.
  const access: FormAccessMode = preset.requiresClassroom
    ? 'CLASSROOM'
    : body.access === 'CLASSROOM'
      ? 'CLASSROOM'
      : 'PUBLIC';

  const fields = preset.fields();

  let form;
  try {
    form = await ClassmojiService.form.create({
      classroomId: classroom.id,
      title,
      access,
      createdBy: userId,
      ...(fields.length > 0 ? { fields } : {}),
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FORM_SLUG_RESERVED') {
      return { error: 'That title does not produce a usable web address. Try adding a word.' };
    }
    if (code === 'FORM_SLUG_UNAVAILABLE') {
      return { error: 'Every address for that title is taken in this classroom. Try another.' };
    }
    if (code === 'FORM_DEFINITION_INVALID' || code === 'FORM_FIELD_ACCESS_VIOLATION') {
      return { error: (error as Error).message };
    }
    throw error;
  }

  await ClassmojiService.audit.create({
    user_id: userId,
    classroom_id: classroom.id,
    role: membership.role,
    resource_type: 'FORMS',
    resource_id: form.id,
    action: 'CREATE',
    data: {
      tool: 'forms.new.create',
      title: form.title,
      slug: form.slug,
      access,
      preset: preset.key,
    },
  });

  return redirect(`/${classroomSlug}/forms/${form.slug}/edit`);
};

export default function NewFormDrawer() {
  const params = useParams();
  const navigate = useNavigate();
  const fetcher = useFetcher<{ error?: string }>();

  const [presetKey, setPresetKey] = useState('blank');
  const [title, setTitle] = useState('');
  const [access, setAccess] = useState<FormAccessMode>('PUBLIC');
  const [touchedTitle, setTouchedTitle] = useState(false);

  const preset = presetByKey(presetKey);
  const submitting = fetcher.state !== 'idle';
  const close = () => navigate(`/${params.classroomSlug}/forms`);

  // Choosing a template proposes its title and its mode; typing over either one
  // wins. Retargeting the mode is refused only for a template whose fields the
  // server would reject on a public form.
  useEffect(() => {
    if (!touchedTitle) setTitle(preset.suggestedTitle);
    setAccess(preset.requiresClassroom ? 'CLASSROOM' : preset.access);
  }, [presetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const submit = () => {
    fetcher.submit(
      { title, access, preset: presetKey },
      { method: 'post', encType: 'application/json' }
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={close}
        role="presentation"
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="New form"
        aria-modal="true"
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl dark:bg-gray-800"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">New form</h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-6 px-5 py-5">
          <div>
            <label
              htmlFor="form-title"
              className="mb-1.5 block text-sm font-medium text-gray-800 dark:text-gray-100"
            >
              Title
            </label>
            <input
              id="form-title"
              value={title}
              onChange={event => {
                setTouchedTitle(true);
                setTitle(event.target.value);
              }}
              placeholder="CS52 Waitlist"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The web address comes from the title and is fixed once the form is created.
            </p>
          </div>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
              Who can fill it in
            </legend>
            <div className="space-y-2">
              {[
                {
                  value: 'PUBLIC' as const,
                  title: 'Public link',
                  blurb:
                    'Anyone with the link. Identity is their email address, proven by a verification link.',
                },
                {
                  value: 'CLASSROOM' as const,
                  title: 'Classroom',
                  blurb: 'Members only, signed in. Unlocks roster-sourced and team-review fields.',
                },
              ].map(choice => {
                const locked = preset.requiresClassroom && choice.value === 'PUBLIC';
                return (
                  <label
                    key={choice.value}
                    className={`grid cursor-pointer grid-cols-[auto_1fr] gap-x-2.5 rounded-md border p-3 ${
                      access === choice.value
                        ? 'border-gray-900 dark:border-white'
                        : 'border-gray-200 dark:border-gray-700'
                    } ${locked ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <input
                      type="radio"
                      name="access"
                      className="mt-1"
                      value={choice.value}
                      disabled={locked}
                      checked={access === choice.value}
                      onChange={() => setAccess(choice.value)}
                    />
                    {/* The title sits as a DIRECT child of the label, not nested
                        inside a wrapper span: that is what makes it the control's
                        accessible name (and what jsx-a11y checks for). The grid
                        keeps the two-line layout without the wrapper. */}
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {choice.title}
                    </span>
                    <span className="col-start-2 text-xs text-gray-500 dark:text-gray-400">
                      {choice.blurb}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              {preset.requiresClassroom
                ? 'This template uses team-review fields, which only exist inside a classroom.'
                : 'This is fixed once the form is published — the two modes identify respondents differently.'}
            </p>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
              Start from
            </legend>
            <div className="space-y-2">
              {FORM_PRESETS.map(option => (
                <label
                  key={option.key}
                  className={`grid cursor-pointer grid-cols-[auto_1fr] gap-x-2.5 rounded-md border p-3 ${
                    presetKey === option.key
                      ? 'border-gray-900 dark:border-white'
                      : 'border-gray-200 dark:border-gray-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="preset"
                    className="mt-1"
                    value={option.key}
                    checked={presetKey === option.key}
                    onChange={() => setPresetKey(option.key)}
                  />
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {option.label}
                  </span>
                  <span className="col-start-2 text-xs text-gray-500 dark:text-gray-400">
                    {option.blurb}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {fetcher.data?.error ? (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {fetcher.data.error}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={close}
            className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || title.trim().length === 0}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-gray-900"
          >
            {submitting ? 'Creating…' : 'Create form'}
          </button>
        </div>
      </div>
    </div>
  );
}
