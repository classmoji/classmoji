import { useEffect, useMemo, useState } from 'react';
import { useFetcher } from 'react-router';
import {
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Segmented,
  Select,
  Spin,
  Tag,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useDebounce } from '@uidotdev/usehooks';
import { titleToIdentifier } from '@classmoji/utils';

import { ASSIGNMENT_TYPE_META, type AssignmentRowData } from './AssignmentsTable';

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
}

/** Where a new REPO assignment's repository comes from. */
type RepoSource = 'new' | 'existing';

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
  title: string;
  weight: number;
  is_extra_credit: boolean;
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
      is_extra_credit: assignment?.is_extra_credit ?? false,
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
      is_extra_credit: values.is_extra_credit,
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
      title={isEdit ? `Edit assignment: ${assignment?.title}` : 'New assignment'}
      okText={isEdit ? 'Save' : 'Create'}
      onOk={submit}
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      destroyOnHidden
      width={640}
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

        <Form.Item label="Students submit through" name="type">
          <Segmented
            block
            disabled={isEdit || !!presetKind}
            options={(Object.keys(ASSIGNMENT_TYPE_META) as AssignmentKind[]).map(t => ({
              value: t,
              label: ASSIGNMENT_TYPE_META[t].label,
            }))}
            onChange={value => {
              setKind(value as AssignmentKind);
              form.setFieldValue('target_id', undefined);
            }}
          />
        </Form.Item>

        <Form.Item
          name="title"
          label="Title"
          rules={[{ required: true, message: 'Enter a title' }]}
        >
          <Input placeholder="Lab 3: Linked lists" />
        </Form.Item>

        {kind === 'REPO' && !isEdit && (
          <Form.Item name="repo_source" label="Repository">
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
          <Form.Item
            name="template"
            label="Template repository"
            extra={
              <>
                Each student&apos;s copy will be named{' '}
                <code className="text-ink-1">{repoSlug}-&lt;github-login&gt;</code>. Need a team
                repository?{' '}
                <a href={newRepositoryHref} target="_blank" rel="noreferrer">
                  Create it on the Repositories page
                </a>
                .
              </>
            }
            rules={[{ required: true, message: 'Pick a template repository' }]}
          >
            <Select
              showSearch
              filterOption={false}
              placeholder="Type to search template repositories…"
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Form.Item
            name="weight"
            label="Weight"
            rules={[{ required: true, message: 'Enter a weight' }]}
          >
            <InputNumber addonAfter="%" min={0} className="w-full" />
          </Form.Item>
          <Form.Item name="tokens_per_hour" label="Tokens per late hour">
            <InputNumber min={0} className="w-full" />
          </Form.Item>
          <Form.Item name="is_extra_credit" valuePropName="checked" label=" ">
            <Checkbox>Extra credit</Checkbox>
          </Form.Item>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Form.Item name="release_at" label="Release">
            <DatePicker showTime className="w-full" format="MMM D, YYYY h:mm A" />
          </Form.Item>
          <Form.Item name="student_deadline" label="Student deadline">
            <DatePicker showTime className="w-full" format="MMM D, YYYY h:mm A" />
          </Form.Item>
          <Form.Item name="grader_deadline" label="Grader deadline">
            <DatePicker showTime className="w-full" format="MMM D, YYYY h:mm A" />
          </Form.Item>
        </div>

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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
