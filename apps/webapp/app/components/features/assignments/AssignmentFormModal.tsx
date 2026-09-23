import { useEffect, useMemo, useState } from 'react';
import { useFetcher } from 'react-router';
import { DatePicker, Form, Input, InputNumber, Modal, Radio, Select, Spin, Tag } from 'antd';
import { IconArrowRight } from '@tabler/icons-react';
import dayjs, { type Dayjs } from 'dayjs';
import { useDebounce } from '@uidotdev/usehooks';
import { titleToIdentifier } from '@classmoji/utils';

import { type AssignmentRowData } from './AssignmentsTable';

export type AssignmentKind = 'REPO' | 'QUIZ' | 'FORM';
export type SubmissionMode = 'ISSUE' | 'REPO';

export interface AssignmentFormModalProps {
  open: boolean;
  onClose: () => void;
  classSlug: string;
  /** Preselects (and locks) the module when opened from a module page. */
  moduleId?: string;
  modules: Array<{ id: string; title: string }>;
  /** Every repository in the classroom: a REPO assignment may submit through any of them. */
  repositories: Array<{ id: string; title: string; is_published: boolean }>;
  quizzes: Array<{ id: string; name: string; status: string }>;
  forms: Array<{ id: string; title: string; status: string }>;
  /** Pages / slide decks the assignment can link as its resources. */
  pages?: Array<{ id: string; title: string | null }>;
  slides?: Array<{ id: string; title: string | null }>;
  /** Quiz / form ids already bound to another assignment (each may bind once). */
  boundQuizIds: Set<string>;
  boundFormIds: Set<string>;
  /** Editing an existing assignment; null creates a new one. */
  assignment: AssignmentRowData | null;
  /** Fix the kind on create (the caller already asked which kind). */
  presetKind?: AssignmentKind;
  /** Preselect the repository for a new REPO assignment (an issue in that repo). */
  presetRepositoryId?: string;
  /** Team tags in this classroom, for an instructor-assigned team assignment. */
  tags?: { id: string; name: string }[];
}

/** Where a new REPO assignment's repository comes from. */
type RepoSource = 'new' | 'existing';

/** How teams are filled for a team assignment. */
type TeamFormation = 'INSTRUCTOR' | 'SELF_FORMED';

/**
 * Who a repository is cut for. Two cards rather than a switch: "individual" is
 * a real choice here, not the absence of one. antd hands `value`/`onChange` in.
 */
const WhoSubmits = ({
  value,
  onChange,
}: {
  value?: boolean;
  onChange?: (next: boolean) => void;
}) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    {[
      { v: false, title: 'Each student', hint: 'one repository per person' },
      { v: true, title: 'Each team', hint: 'one repository per team' },
    ].map(option => {
      const selected = !!value === option.v;
      return (
        <label
          key={String(option.v)}
          className={`flex cursor-pointer flex-col gap-1 rounded-xl border px-4 py-3 transition-colors ${
            selected
              ? 'border-[#D97757] bg-[#FDF1EC] dark:border-amber-700 dark:bg-amber-900/20'
              : 'border-line bg-white dark:bg-neutral-900 hover:border-[#E0A98F]'
          }`}
        >
          <span className="flex items-center gap-2">
            <input
              type="radio"
              name="assignment-who-submits"
              checked={selected}
              onChange={() => onChange?.(option.v)}
              className="h-4 w-4 accent-[#D97757]"
            />
            <span
              className={`text-sm font-semibold ${
                selected ? 'text-[#8F3F20] dark:text-amber-200' : 'text-ink-1'
              }`}
            >
              {option.title}
            </span>
          </span>
          <span className="pl-6 text-xs text-ink-3">{option.hint}</span>
        </label>
      );
    })}
  </div>
);

/** A numbered rule between groups of fields, so the form reads as a sequence. */
const Section = ({
  n,
  title,
  className = '',
}: {
  n: number;
  title: string;
  className?: string;
}) => (
  <div className={`flex items-center gap-2.5 mb-4 ${className}`}>
    <span className="text-[10px] font-bold tracking-widest text-[#B4552F] dark:text-amber-500">
      {n}
    </span>
    <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</span>
    <span className="h-px flex-1 bg-line" />
  </div>
);

interface TemplateRepository {
  full_name: string;
  private: boolean;
  language: string | null;
  stargazers_count: number;
}

// Same endpoint as the Repositories form: the classroom org's repos (public and
// private) plus public templates anywhere, searched with the installation token.
const searchTemplates = async (query: string, classSlug: string): Promise<TemplateRepository[]> => {
  try {
    const params = new URLSearchParams({ classroomSlug: classSlug, q: query });
    const response = await fetch(`/api/github-repos?${params.toString()}`);
    if (!response.ok) return [];
    const data = (await response.json()) as TemplateRepository[] | { error: string };
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
};

interface FormValues {
  module_id?: string;
  type: AssignmentKind;
  submission_mode: SubmissionMode;
  target_id?: string;
  repo_source: RepoSource;
  template?: string;
  is_team: boolean;
  team_formation_mode: TeamFormation;
  max_team_size?: number | null;
  tag_id?: string;
  title: string;
  weight: number;
  release_at: Dayjs | null;
  student_deadline: Dayjs | null;
  grader_deadline: Dayjs | null;
  tokens_per_hour: number;
  description: string;
  page_ids: string[];
  slide_ids: string[];
}

const toIso = (value: Dayjs | null | undefined) => (value ? value.toISOString() : null);

/**
 * Create / edit one assignment. Pick how students submit (a repository, a
 * quiz, or a form). A repository can be created on the spot from a template,
 * named after the assignment title, or picked from the ones the class already
 * has. Kind and target are fixed once created; everything else is editable.
 * Posts to the class-level assignments action.
 */
const AssignmentFormModal = ({
  open,
  onClose,
  classSlug,
  moduleId,
  modules,
  repositories,
  quizzes,
  forms,
  pages = [],
  slides = [],
  boundQuizIds,
  boundFormIds,
  assignment,
  presetKind,
  presetRepositoryId,
  tags = [],
}: AssignmentFormModalProps) => {
  const fetcher = useFetcher<{ success?: string; error?: string }>();
  const [form] = Form.useForm<FormValues>();
  const [kind, setKind] = useState<AssignmentKind>('REPO');
  const [mode, setMode] = useState<SubmissionMode>('REPO');
  const isEdit = !!assignment;
  // The mode is frozen once any student has a submission row: flipping it
  // would strand issues already opened, or rows that expect none.
  const modeLocked = isEdit && (assignment?._count?.git_repo_assignments ?? 0) > 0;
  const busy = fetcher.state !== 'idle';

  // New REPO assignment: a fresh repository from a template (the default), or
  // one the class already has. The title names the repository, so each
  // student's copy is `<title-slug>-<login>`.
  const [repoSource, setRepoSource] = useState<RepoSource>('new');
  const title = Form.useWatch('title', form) ?? '';
  const repoSlug = titleToIdentifier(title || '') || 'repo-name';
  // Team config for a repository created here. Provisioning is per-repository,
  // so this decides whether each copy belongs to a student or to a team.
  const isTeam = Form.useWatch('is_team', form) ?? false;
  const teamFormation = (Form.useWatch('team_formation_mode', form) ??
    'INSTRUCTOR') as TeamFormation;
  // Section numbers shift: "Who submits" and "What counts as submitting" only
  // exist for a new REPO assignment.
  const isRepoCreate = kind === 'REPO' && !isEdit;
  const gradingStep = isRepoCreate ? 4 : kind === 'REPO' ? 3 : 2;
  // Opened from a module card, so the module is already settled: it rides in
  // the header as context instead of taking a field.
  const knownModule = moduleId ? modules.find(m => m.id === moduleId) : undefined;
  const [templateQuery, setTemplateQuery] = useState('');
  const [templateOptions, setTemplateOptions] = useState<TemplateRepository[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const debouncedTemplateQuery = useDebounce(templateQuery, 400);
  useEffect(() => {
    if (debouncedTemplateQuery.trim().length < 2) {
      setTemplateOptions([]);
      return;
    }
    let cancelled = false;
    setTemplateLoading(true);
    searchTemplates(debouncedTemplateQuery.trim(), classSlug).then(result => {
      if (cancelled) return;
      setTemplateOptions(result);
      setTemplateLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedTemplateQuery, classSlug]);

  // Reset the form each time the modal opens for a different target.
  useEffect(() => {
    if (!open) return;
    const nextKind = (assignment?.type as AssignmentKind) ?? presetKind ?? 'REPO';
    setKind(nextKind);
    // New assignments default to "a push is the submission"; existing ones
    // keep whatever they were created with.
    const nextMode: SubmissionMode = assignment?.submission_mode === 'ISSUE' ? 'ISSUE' : 'REPO';
    setMode(assignment ? nextMode : 'REPO');
    // Opened from a repository row: that repository is the target.
    const nextSource: RepoSource = presetRepositoryId ? 'existing' : 'new';
    setRepoSource(nextSource);
    setTemplateQuery('');
    form.setFieldsValue({
      repo_source: nextSource,
      template: undefined,
      is_team: false,
      team_formation_mode: 'INSTRUCTOR',
      max_team_size: undefined,
      tag_id: undefined,
      // A module card hands its assignments over without the module relation.
      module_id: assignment?.module?.id ?? moduleId,
      type: nextKind,
      submission_mode: assignment ? nextMode : 'REPO',
      target_id:
        assignment?.repository?.id ??
        assignment?.quiz?.id ??
        assignment?.form?.id ??
        (nextKind === 'REPO' ? presetRepositoryId : undefined),
      title: assignment?.title ?? '',
      weight: assignment?.weight ?? 100,
      release_at: assignment?.release_at ? dayjs(assignment.release_at) : null,
      student_deadline: assignment?.student_deadline ? dayjs(assignment.student_deadline) : null,
      grader_deadline: assignment?.grader_deadline ? dayjs(assignment.grader_deadline) : null,
      tokens_per_hour: assignment?.tokens_per_hour ?? 0,
      description: assignment?.description ?? '',
      page_ids: assignment?.pages?.map(l => l.page.id) ?? [],
      slide_ids: assignment?.slides?.map(l => l.slide.id) ?? [],
    });
  }, [open, assignment, moduleId, form, presetKind, presetRepositoryId]);

  // Close once a submit settles successfully.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success && open) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const targetOptions = useMemo(() => {
    switch (kind) {
      case 'REPO':
        return repositories.map(r => ({
          value: r.id,
          label: r.is_published ? r.title : `${r.title} · draft`,
        }));
      case 'QUIZ':
        return quizzes
          .filter(q => !boundQuizIds.has(q.id) || q.id === assignment?.quiz?.id)
          .map(q => ({ value: q.id, label: `${q.name} · ${q.status.toLowerCase()}` }));
      case 'FORM':
        return forms
          .filter(f => !boundFormIds.has(f.id) || f.id === assignment?.form?.id)
          .map(f => ({ value: f.id, label: `${f.title} · ${f.status.toLowerCase()}` }));
      default:
        return [];
    }
  }, [kind, repositories, quizzes, forms, boundQuizIds, boundFormIds, assignment]);

  const newRepositoryHref = `/admin/${classSlug}/repos/form`;
  const emptyTargetHint = {
    REPO: (
      <>
        No repositories yet.{' '}
        <a href={newRepositoryHref} target="_blank" rel="noreferrer">
          New repository
        </a>
      </>
    ),
    QUIZ: 'No quizzes to bind. Create one on the Quizzes page first.',
    FORM: 'No forms to bind. Create one in the forms app first.',
  }[kind];

  const submit = async () => {
    const values = await form.validateFields();
    const payload: Record<string, unknown> = {
      title: values.title,
      weight: values.weight,
      // The checkbox is gone from the form; an existing value must survive an edit.
      is_extra_credit: assignment?.is_extra_credit ?? false,
      release_at: toIso(values.release_at),
      student_deadline: toIso(values.student_deadline),
      grader_deadline: toIso(values.grader_deadline),
      tokens_per_hour: values.tokens_per_hour ?? 0,
      description: values.description ?? '',
      page_ids: values.page_ids ?? [],
      slide_ids: values.slide_ids ?? [],
    };
    if (isEdit) {
      payload.id = assignment!.id;
      if (kind === 'REPO' && !modeLocked) payload.submission_mode = mode;
    } else {
      payload.submission_mode = kind === 'REPO' ? mode : 'ISSUE';
      // validateFields only returns rendered fields; when the module picker
      // is hidden the module comes from the page that opened the modal.
      payload.module_id = values.module_id ?? moduleId;
      payload.type = kind;
      // A new repository is created by the action, named after the title.
      const newRepo = kind === 'REPO' && repoSource === 'new';
      payload.repository_id = kind === 'REPO' && !newRepo ? values.target_id : null;
      payload.template = newRepo ? values.template : undefined;
      // The action creates the repository, so team config rides along with it.
      if (newRepo && values.is_team) {
        payload.repository_type = 'GROUP';
        payload.team_formation_mode = values.team_formation_mode;
        payload.max_team_size = values.max_team_size ?? null;
        payload.tag_id = values.team_formation_mode === 'INSTRUCTOR' ? values.tag_id : null;
      }
      payload.quiz_id = kind === 'QUIZ' ? values.target_id : null;
      payload.form_id = kind === 'FORM' ? values.target_id : null;
    }
    fetcher.submit(JSON.stringify(payload), {
      method: 'post',
      action: `/admin/${classSlug}/assignments?/${isEdit ? 'update' : 'create'}`,
      encType: 'application/json',
    });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <span className="flex items-center gap-2.5">
          <span>{isEdit ? `Edit assignment: ${assignment?.title}` : 'New assignment'}</span>
          {knownModule && (
            <span className="rounded-full border border-line bg-stone-100 dark:bg-neutral-800 px-2.5 py-0.5 text-xs font-normal text-ink-3">
              {knownModule.title}
            </span>
          )}
        </span>
      }
      okText={isEdit ? 'Save' : 'Create'}
      onOk={submit}
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      destroyOnHidden
      width={720}
    >
      {fetcher.data?.error && (
        <div className="mb-3 text-sm text-rose-600 dark:text-rose-400">{fetcher.data.error}</div>
      )}
      <Form form={form} layout="vertical" className="mt-2">
        {!moduleId && (
          <Form.Item
            name="module_id"
            label="Module"
            rules={[{ required: true, message: 'Choose a module' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Choose a module"
              disabled={isEdit}
              options={modules.map(m => ({ value: m.id, label: m.title }))}
            />
          </Form.Item>
        )}

        <Form.Item
          name="title"
          label="Assignment title"
          rules={[{ required: true, message: 'Enter a title' }]}
        >
          <Input placeholder="Lab 3: Linked lists" />
        </Form.Item>

        {kind === 'REPO' && !isEdit && (
          <>
            <Section n={1} title="Who submits" className="mt-5" />

            <Form.Item name="is_team" className="mb-5">
              <WhoSubmits
                onChange={next => {
                  form.setFieldValue('is_team', next);
                  if (!next) form.setFieldValue('tag_id', undefined);
                }}
              />
            </Form.Item>

            {isTeam && repoSource === 'new' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 rounded-xl border border-[#F0E3DB] dark:border-amber-800/40 bg-[#FDF7F4] dark:bg-amber-900/10 px-4 pt-4 pb-1 mb-6">
                <Form.Item name="team_formation_mode" label="Team formation">
                  <Select
                    options={[
                      { value: 'INSTRUCTOR', label: 'Instructor assigned' },
                      { value: 'SELF_FORMED', label: 'Student self-formed' },
                    ]}
                  />
                </Form.Item>

                <Form.Item name="max_team_size" label="Max team size">
                  <InputNumber min={2} style={{ width: '100%' }} placeholder="e.g. 4" />
                </Form.Item>

                {teamFormation === 'INSTRUCTOR' && (
                  <Form.Item
                    name="tag_id"
                    label="Team tag"
                    className="md:col-span-2"
                    rules={[{ required: true, message: 'Pick the tag whose teams get a repo' }]}
                    extra={
                      tags.length
                        ? 'Every team carrying this tag gets one repository.'
                        : 'This classroom has no team tags yet — create one on the Teams page, or let students self-form.'
                    }
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="Choose a team tag…"
                      options={tags.map(t => ({ value: t.id, label: t.name }))}
                      notFoundContent={<span className="text-sm text-ink-3">No team tags</span>}
                    />
                  </Form.Item>
                )}
              </div>
            )}

            {isTeam && repoSource === 'existing' && (
              <div className="-mt-2 mb-6 text-sm text-ink-3">
                Team formation comes from the repository you pick below.
              </div>
            )}
          </>
        )}

        <Section
          n={kind === 'REPO' && !isEdit ? 2 : 1}
          title={kind === 'REPO' ? 'Where the code lives' : 'Source'}
          className="mt-2"
        />

        {kind === 'REPO' && !isEdit && (
          <Form.Item name="repo_source" label="Where it comes from">
            <Radio.Group
              onChange={e => {
                setRepoSource(e.target.value as RepoSource);
                form.setFieldValue('target_id', undefined);
                form.setFieldValue('template', undefined);
              }}
              className="flex flex-col gap-1"
            >
              <Radio value="new">
                New repository from a template{' '}
                <span className="text-ink-3">— starter code students get a copy of</span>
              </Radio>
              <Radio value="existing">
                Existing repository{' '}
                <span className="text-ink-3">— one this class already uses</span>
              </Radio>
            </Radio.Group>
          </Form.Item>
        )}

        {kind === 'REPO' && !isEdit && repoSource === 'new' ? (
          <>
            <Form.Item
              name="template"
              label="Template repository"
              extra={
                <>
                  Optional. Leave empty to create a blank, private{' '}
                  <code className="text-ink-1">{repoSlug}-template</code>.
                </>
              }
            >
              <Select
                showSearch
                filterOption={false}
                placeholder="Leave empty for a blank template, or search…"
                loading={templateLoading}
                onSearch={setTemplateQuery}
                notFoundContent={
                  templateLoading ? (
                    <span className="text-sm text-ink-3">
                      <Spin size="small" /> Searching…
                    </span>
                  ) : (
                    <span className="text-sm text-ink-3">
                      {templateQuery.trim().length >= 2
                        ? 'No template repositories found'
                        : 'Type to search GitHub for a template'}
                    </span>
                  )
                }
                options={templateOptions.map(t => ({
                  value: t.full_name,
                  label: (
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{t.full_name}</span>
                        {t.private && (
                          <Tag color="gold" className="m-0">
                            Private
                          </Tag>
                        )}
                      </span>
                      <span className="text-xs text-ink-3">
                        {Number(t.stargazers_count) > 0 && `⭐${t.stargazers_count} `}
                        {t.language ?? ''}
                      </span>
                    </span>
                  ),
                }))}
              />
            </Form.Item>

            {/* Derived from the choices above, so it reads last, not as a field. */}
            <div className="-mt-1 mb-6 flex w-fit flex-wrap items-center gap-2 rounded-lg bg-stone-100 dark:bg-neutral-800 px-3 py-2">
              <IconArrowRight size={14} className="text-ink-3" aria-hidden />
              <span className="text-sm text-ink-3">
                {isTeam ? 'Each team gets' : 'Each student gets'}
              </span>
              <code className="rounded-md bg-stone-200/70 dark:bg-neutral-700 px-2 py-0.5 text-sm text-ink-1">
                {repoSlug}-&lt;{isTeam ? 'team' : 'github-login'}&gt;
              </code>
            </div>
          </>
        ) : (
          <Form.Item
            name="target_id"
            label={{ REPO: 'Repository', QUIZ: 'Quiz', FORM: 'Form' }[kind]}
            extra={
              kind === 'REPO' && !isEdit
                ? 'Students who already have a copy of this repository keep it; the assignment is added to it.'
                : undefined
            }
            rules={[{ required: true, message: 'Pick a target' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              disabled={isEdit}
              placeholder={`Select a ${kind.toLowerCase()}…`}
              options={targetOptions}
              notFoundContent={<span className="text-sm text-ink-3">{emptyTargetHint}</span>}
            />
          </Form.Item>
        )}

        {kind === 'REPO' && (
          <Section n={isRepoCreate ? 3 : 2} title="What counts as submitting" className="mt-2" />
        )}

        {kind === 'REPO' && (
          <Form.Item
            name="submission_mode"
            label="Submission"
            extra={
              modeLocked
                ? 'Fixed: students already have submission rows for this assignment.'
                : undefined
            }
          >
            <Radio.Group
              disabled={modeLocked}
              onChange={e => setMode(e.target.value as SubmissionMode)}
              className="flex flex-col gap-1"
            >
              <Radio value="REPO">
                Push to the repository{' '}
                <span className="text-ink-3">
                  — the last push before the deadline is the submission
                </span>
              </Radio>
              <Radio value="ISSUE">
                Close a GitHub issue{' '}
                <span className="text-ink-3">— Classmoji opens one in each student repo</span>
              </Radio>
            </Radio.Group>
          </Form.Item>
        )}

        <Section n={gradingStep} title="Grading & schedule" className="mt-2" />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
          <Form.Item
            name="weight"
            label="Weight"
            rules={[{ required: true, message: 'Enter a weight' }]}
          >
            <InputNumber addonAfter="%" min={0} className="w-full" />
          </Form.Item>
          <Form.Item name="tokens_per_hour" label="Tokens per late hour">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-4">
          <Form.Item name="release_at" label="Release date">
            <DatePicker showTime className="w-full" format="MMM D, YYYY h:mm A" />
          </Form.Item>
          <Form.Item name="student_deadline" label="Student deadline">
            <DatePicker showTime className="w-full" format="MMM D, YYYY h:mm A" />
          </Form.Item>
          <Form.Item name="grader_deadline" label="Grader deadline">
            <DatePicker showTime className="w-full" format="MMM D, YYYY h:mm A" />
          </Form.Item>
        </div>

        <Section n={gradingStep + 1} title="Content" className="mt-2" />

        {kind === 'REPO' && (
          <Form.Item
            name="description"
            label={mode === 'ISSUE' ? 'Issue body' : 'Instructions'}
            extra={
              mode === 'ISSUE'
                ? 'Becomes the body of the issue created in each student repository.'
                : 'Shown to students with the assignment.'
            }
          >
            <Input.TextArea rows={4} />
          </Form.Item>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
          <Form.Item name="page_ids" label="Linked pages">
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="Pages students should read"
              options={pages.map(p => ({ value: p.id, label: p.title || 'Untitled' }))}
            />
          </Form.Item>
          <Form.Item name="slide_ids" label="Linked slides">
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="Slide decks for this assignment"
              options={slides.map(d => ({ value: d.id, label: d.title || 'Untitled' }))}
            />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
};

export default AssignmentFormModal;
