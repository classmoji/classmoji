import { useEffect, useState, useMemo } from 'react';
import { redirect, useFetcher, useLocation, useNavigate, useParams } from 'react-router';
import { useCallout } from '@classmoji/ui-components';
import {
  Alert,
  Drawer,
  ConfigProvider,
  theme,
  Form,
  Input,
  Modal,
  Select,
  Button,
  Switch,
  Space,
  Tooltip,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { RobotOutlined, DeleteOutlined, BulbOutlined } from '@ant-design/icons';
import { useRouteDrawer, useDarkMode } from '~/hooks';
import { assertClassroomAccess } from '~/utils/helpers';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import { ClassmojiService } from '@classmoji/services';
import { QUIZ_AUTHOR_SETTING_KEYS, canAuthorQuiz } from '@classmoji/utils';
import { PromptAssistant, type PromptSuggestion } from '~/components/quiz/PromptAssistant';
import {
  normalizeExcludedPaths,
  parseExcludedPathsText,
} from '@classmoji/utils/quiz-excluded-paths';
import { MAX_STUDENT_TURNS } from '@classmoji/utils/quiz-agent/limits';
import { QUIZ_MESSAGE_LIMIT_COPY } from '@classmoji/utils/quiz-agent/copy';
import { runtimeFor } from '~/utils/quizRuntime.server';
import {
  fromPickerValue,
  pickerLabel,
  pickerOptions,
  toPickerValue,
  toPickerValues,
  type LinkedDoc,
  type PickerDoc,
} from './sourceMaterialPicker';
import {
  EditableAssignmentPanel,
  ReadOnlyAssignmentPanel,
  changedPanelPayload,
  closesDateError,
  panelDatesChanged,
  panelFormValues,
  panelPayload,
  type AssignmentPanelData,
} from './QuizAssignmentPanel';

import type { Route } from './+types/route';

import './quiz-form.css';

const { TextArea } = Input;
const { Option } = Select;

const EXCLUDED_PATHS_PLACEHOLDER = 'tests/**\n**/*.spec.js\nplaywright.config.*';

/** The loader's reading of the runtime switch: whether a new attempt runs on the chat runtime. */
type ChatRuntimeFor = { codeAware: boolean; other: boolean };

/**
 * Whether a new attempt of the quiz, as the form has it now, runs on the chat
 * runtime (whose message limit the form states). A quiz is code-aware there
 * with a linked repository and code context on (quizRuntime.server.ts,
 * isCodeAwareQuiz). Not shown when the loader sent no reading.
 */
const runsOnChatRuntime = (
  chatRuntime: ChatRuntimeFor | undefined,
  fields: { repositoryId?: unknown; includeCodeContext?: unknown }
): boolean => {
  if (!chatRuntime) return false;
  const codeAware = Boolean(fields.repositoryId) && fields.includeCodeContext === true;
  return codeAware ? chatRuntime.codeAware : chatRuntime.other;
};

/** The "Paths to exclude" textarea's rule: the same check the quiz service makes. */
const validateExcludedPaths = (_rule: unknown, value: string | undefined) => {
  const result = normalizeExcludedPaths(parseExcludedPathsText(value));
  return result.ok ? Promise.resolve() : Promise.reject(new Error(result.error));
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const classSlug = params.class!;
  const url = new URL(request.url);
  const quizId = url.searchParams.get('quizId');

  // Dynamic import to keep server-side dependencies on the server only
  const { getExamplePrompts } = await import('@classmoji/services');

  const {
    userId: _userId,
    classroom,
    membership,
  } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'ADMIN_QUIZ_FORM',
    attemptedAction: quizId ? 'edit_quiz' : 'create_quiz',
  });

  if (!(await quizzesVisibleOrThrow(classroom.id))) {
    throw new Response('Not Found', { status: 404 });
  }

  // Creating a quiz is the owner's and teachers' (the quizzes action refuses
  // anyone else): a teaching assistant who opens the form with no quiz goes
  // back to the quiz list it opens over, under the prefix they came by.
  const canAuthor = canAuthorQuiz(membership?.role);
  if (!quizId && !canAuthor) {
    throw redirect(url.pathname.replace(/\/form\/?$/, '') || `/assistant/${classSlug}/quizzes`);
  }

  // Fetch repositories for linking
  const repositories = await ClassmojiService.repository.findByClassroomId(classroom.id);
  // The modules a quiz can live in, for the Assignment panel.
  const modules = (await ClassmojiService.module.findByClassroomSlug(classSlug)).map(m => ({
    id: m.id,
    title: m.title,
  }));
  // Opened from a module's "Add → Quiz": that module, if it is this class's.
  const requestedModuleId = url.searchParams.get('moduleId');
  const presetModuleId = modules.some(m => m.id === requestedModuleId) ? requestedModuleId : null;
  const examplePrompts = getExamplePrompts();
  // Pages and reveal.js decks for the source-material picker (id, title, draft).
  const sourceMaterialOptions = await ClassmojiService.quizSourceMaterial.listSourceMaterialOptions(
    classroom.id
  );

  // If editing, fetch the quiz data
  let quiz = null;
  // The documents the quiz links now, which the picker must be able to name.
  let linked: ReadonlyArray<LinkedDoc> = [];
  // The Assignment panel: a new quiz starts unpublished at weight 0 (in the
  // module it was added from, if any).
  let assignmentPanel: AssignmentPanelData = {
    moduleId: presetModuleId,
    moduleTitle: modules.find(m => m.id === presetModuleId)?.title ?? null,
    releaseAt: null,
    dueDate: null,
    closesAt: null,
    weight: 0,
    isPublished: false,
  };
  if (quizId) {
    const found = await ClassmojiService.quiz.findById(quizId);
    if (!found || found.classroom_id.toString() !== classroom.id.toString()) {
      throw new Response('Quiz not found', { status: 404 });
    }
    linked = found.source_material;

    // Its assignment's values; a quiz in no module shows what it has today
    // (its own due date, weight and publish state), and a closed one closes
    // at its last update, as the save will record it.
    const assignment = found.assignment;
    assignmentPanel = assignment
      ? {
          moduleId: assignment.module_id,
          moduleTitle: assignment.module?.title ?? null,
          releaseAt: assignment.release_at?.toISOString() ?? null,
          dueDate: assignment.student_deadline?.toISOString() ?? null,
          closesAt: assignment.closes_at?.toISOString() ?? null,
          weight: assignment.weight,
          isPublished: assignment.is_published,
        }
      : {
          moduleId: null,
          moduleTitle: null,
          releaseAt: null,
          dueDate: found.due_date?.toISOString() ?? null,
          closesAt: found.status === 'CLOSED' ? found.updated_at.toISOString() : null,
          weight: found.weight,
          isPublished: found.status !== 'DRAFT',
        };

    // Transform for frontend. Due date, weight and publish state are the
    // Assignment panel's (above), not quiz fields.
    quiz = {
      id: found.id,
      name: found.name,
      repositoryId: found.repository_id?.toString() || null,
      systemPrompt: found.system_prompt,
      rubricPrompt: found.rubric_prompt,
      subject: found.subject || '',
      difficultyLevel: found.difficulty_level || 'Beginner',
      questionCount: found.question_count || 5,
      maxAttempts: found.max_attempts ?? 1,
      gradingStrategy: found.grading_strategy || 'HIGHEST',
      includeCodeContext: found.include_code_context || false,
      // In material order, as picker values.
      sourceMaterial: toPickerValues(found.source_material),
      courseSearchEnabled: found.course_search_enabled,
      // The textarea's text: one pattern per line.
      excludedPaths: (found.excluded_paths ?? []).join('\n'),
    };
  }

  // Whether a new attempt runs on the chat runtime, for a code-aware quiz and
  // for any other, by the same switch attempt creation reads (runtimeFor).
  // The form picks one as its repository and Code-Aware fields change.
  const chatRuntime: ChatRuntimeFor = {
    codeAware:
      runtimeFor({ repository_id: 'linked', include_code_context: true }) === 'trigger_chat',
    other: runtimeFor({}) === 'trigger_chat',
  };

  return {
    org: classSlug,
    quiz,
    isEditing: Boolean(quizId),
    // Decision 4(b): the owner and teachers edit the Assignment panel, the
    // number of questions, max attempts and grading strategy; they are
    // read-only for a teaching assistant. The quizzes action enforces it.
    canAuthor,
    isOwner: membership?.role === 'OWNER',
    modules,
    assignmentPanel,
    chatRuntime,
    assignments: repositories, // Keep variable name for backward compat with component
    examplePrompts,
    // What the classroom offers, plus any linked document it does not.
    sourceMaterialOptions: pickerOptions(sourceMaterialOptions, linked),
  };
}

function QuizFormDrawer({ loaderData }: Route.ComponentProps) {
  const {
    org,
    quiz,
    isEditing,
    assignments,
    examplePrompts,
    sourceMaterialOptions,
    chatRuntime,
    canAuthor,
    isOwner,
    modules,
    assignmentPanel,
  } = loaderData;
  const callout = useCallout();
  const { opened, close } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const fetcher = useFetcher();
  // Served under every prefix this route's gate allows (/admin, /teacher and /assistant).
  // The submit target matters as much as the links: posting to the other
  // prefix's list route would miss this drawer's parent action.
  const rolePrefix = useLocation().pathname.split('/')[1];

  const [form] = Form.useForm();
  const [modal, modalHolder] = Modal.useModal();
  // I3: the owner or a teacher cannot save a quiz without a module. An
  // assistant's save carries content only, so it needs none.
  const chosenModuleId = Form.useWatch(['assignment', 'moduleId'], form) as string | undefined;
  // Closes may not come before Opens or Due. Checked once a date is changed
  // here, so dates saved before the rule existed do not block a content edit.
  const watchedDates = {
    releaseAt: Form.useWatch(['assignment', 'releaseAt'], form) as Dayjs | null | undefined,
    dueDate: Form.useWatch(['assignment', 'dueDate'], form) as Dayjs | null | undefined,
    closesAt: Form.useWatch(['assignment', 'closesAt'], form) as Dayjs | null | undefined,
  };
  const closesError =
    canAuthor && panelDatesChanged(watchedDates, assignmentPanel)
      ? closesDateError(watchedDates)
      : null;
  const saveBlocked = canAuthor && (!chosenModuleId || closesError !== null);
  const [selectedExample, setSelectedExample] = useState('');
  const [showAssistant, setShowAssistant] = useState(false);
  const [exampleRepoUrl, setExampleRepoUrl] = useState('');

  // Build form context for the assistant
  const formContext = useMemo(() => {
    const values = form.getFieldsValue();
    const linkedModule = assignments?.find(
      (a: {
        id: string;
        title?: string;
        template?: string;
        issues?: Array<{ title: string; body: string }>;
      }) => a.id?.toString() === values.repositoryId?.toString()
    );

    return {
      name: values.name,
      subject: values.subject,
      difficultyLevel: values.difficultyLevel,
      questionCount: values.questionCount,
      includeCodeContext: values.includeCodeContext,
      repository: linkedModule
        ? {
            title: linkedModule.title,
            template: linkedModule.template,
            issues: (
              linkedModule as { issues?: Array<{ title: string; body: string }> }
            ).issues?.map(i => ({
              title: i.title,
              description: i.body,
            })),
          }
        : null,
    };
  }, [form, assignments]);

  // Handle applying suggestions from the assistant
  const handleApplySuggestion = (suggestion: PromptSuggestion) => {
    if (suggestion?.systemPrompt) {
      form.setFieldValue('systemPrompt', suggestion.systemPrompt);
    }
    if (suggestion?.rubricPrompt) {
      form.setFieldValue('rubricPrompt', suggestion.rubricPrompt);
    }
    // Optional fields - quiz name, subject, question count, difficulty level
    if (suggestion?.name) {
      form.setFieldValue('name', suggestion.name);
    }
    if (suggestion?.subject) {
      form.setFieldValue('subject', suggestion.subject);
    }
    if (
      suggestion?.questionCount &&
      suggestion.questionCount >= 1 &&
      suggestion.questionCount <= 20
    ) {
      form.setFieldValue('questionCount', suggestion.questionCount);
    }
    if (
      suggestion?.difficultyLevel &&
      ['Beginner', 'Intermediate', 'Advanced'].includes(suggestion.difficultyLevel)
    ) {
      form.setFieldValue('difficultyLevel', suggestion.difficultyLevel);
    }
  };

  // Set form values when quiz data is loaded (edit mode)
  useEffect(() => {
    if (quiz) {
      form.setFieldsValue({
        ...quiz,
        ...(canAuthor ? { assignment: panelFormValues(assignmentPanel) } : {}),
      });
    }
  }, [quiz, form, canAuthor, assignmentPanel]);

  // Two option groups for the one ordered source-material list.
  const sourceMaterialSelectOptions = useMemo(
    () => [
      {
        label: 'Pages',
        options: sourceMaterialOptions.pages.map((doc: PickerDoc) => ({
          label: pickerLabel(doc),
          value: toPickerValue('page', doc.id),
        })),
      },
      {
        label: 'Slide decks',
        options: sourceMaterialOptions.decks.map((doc: PickerDoc) => ({
          label: pickerLabel(doc),
          value: toPickerValue('slide', doc.id),
        })),
      },
    ],
    [sourceMaterialOptions]
  );

  // A save that published a quiz students cannot start yet (all of its source
  // material is still draft) comes back with a warning alongside the success.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.warning) {
      callout.show({ variant: 'info', title: fetcher.data.warning });
    }
    // `callout` is stable per CalloutProvider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // A refused save answers `{ error }` (source material not in this class,
  // another save of the same material at once, a quiz that is gone) and leaves
  // the drawer open, since only a success closes it: say why, here.
  const saveError =
    fetcher.state === 'idle' && typeof fetcher.data?.error === 'string'
      ? (fetcher.data.error as string)
      : null;

  // Handle successful form submission
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      // If a new quiz was created, navigate to its detail page
      if (fetcher.data.quizId) {
        navigate(`/${rolePrefix}/${classSlug}/quizzes/${fetcher.data.quizId}`);
      } else {
        // For updates, just close the drawer
        close();
      }
    }
  }, [fetcher.state, fetcher.data, navigate, classSlug, close, rolePrefix]);

  const handleExampleSelect = (exampleName: string) => {
    const example = examplePrompts.find(
      (e: { name: string; systemPrompt: string; rubricPrompt: string }) => e.name === exampleName
    );
    if (example) {
      form.setFieldsValue({
        systemPrompt: example.systemPrompt,
        rubricPrompt: example.rubricPrompt,
      });
    }
    setSelectedExample(exampleName);
  };

  const handleSubmit = () => {
    if (saveBlocked) return;
    form.validateFields().then(
      allValues => {
        // Absent while the quiz is not code-aware (the field is not shown): the
        // saved list is left as it is.
        const { excludedPaths: excludedPathsText, assignment, ...values } = allValues;
        // An assistant sees the number of questions, max attempts and grading
        // strategy read-only, and its save never carries them.
        if (!canAuthor) {
          for (const key of QUIZ_AUTHOR_SETTING_KEYS) delete values[key];
        }
        // The Assignment panel, for the owner and teachers only: an
        // assistant's save never carries an assignment field. A new quiz
        // sends it whole; an edit sends only what changed here, so a form
        // opened before someone else's change cannot undo it.
        const panel = isEditing
          ? changedPanelPayload(assignment, assignmentPanel)
          : panelPayload(assignment);
        const formData = {
          ...values,
          ...(typeof excludedPathsText === 'string'
            ? { excludedPaths: parseExcludedPathsText(excludedPathsText) }
            : {}),
          ...(canAuthor && Object.keys(panel).length > 0 ? { assignment: panel } : {}),
          // Selection order is material order: one list across pages and decks.
          sourceMaterial: ((values.sourceMaterial ?? []) as string[]).map(fromPickerValue),
          courseSearchEnabled: values.courseSearchEnabled === true,
          _action: isEditing ? 'updateQuiz' : 'createQuiz',
          id: quiz?.id,
        };

        // Submit to parent route's action
        fetcher.submit(formData, {
          method: 'POST',
          action: `/${rolePrefix}/${classSlug}/quizzes`,
          encType: 'application/json',
        });
      },
      () => {
        // A field that fails its rule shows its own message; nothing is sent.
      }
    );
  };

  const handleDelete = () => {
    if (!quiz?.id) return;
    const quizId = quiz.id;
    modal.confirm({
      title: 'Delete quiz',
      content: assignmentPanel.moduleTitle
        ? `This deletes the quiz and every attempt at it, and removes it from ${assignmentPanel.moduleTitle}.`
        : 'This deletes the quiz and every attempt at it.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () =>
        fetcher.submit(
          { _action: 'deleteQuiz', id: quizId },
          {
            method: 'POST',
            action: `/${rolePrefix}/${classSlug}/quizzes`,
            encType: 'application/json',
          }
        ),
    });
  };

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      {modalHolder}
      <Drawer
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <RobotOutlined />
              {isEditing ? 'Edit Quiz' : 'Create New Quiz'}
            </Space>
            <Tooltip title={showAssistant ? 'Hide AI Assistant' : 'Show AI Assistant'}>
              <Button
                type={showAssistant ? 'primary' : 'default'}
                icon={<BulbOutlined />}
                onClick={() => setShowAssistant(!showAssistant)}
              >
                AI Assistant
              </Button>
            </Tooltip>
          </div>
        }
        open={opened}
        onClose={close}
        width="100%"
        styles={{
          header: {
            backgroundColor: isDarkMode ? '#1f2937' : '#f9f9f9',
          },
          body: {
            padding: 0,
            backgroundColor: isDarkMode ? '#111827' : '#ffffff',
            overflow: 'hidden',
          },
        }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              {/* Deleting takes the quiz's attempts with it: owner and teachers only. */}
              {isEditing && canAuthor && (
                <Button type="primary" danger icon={<DeleteOutlined />} onClick={handleDelete}>
                  Delete
                </Button>
              )}
            </div>
            <Space>
              <Button onClick={close}>Cancel</Button>
              <Button
                type="primary"
                onClick={handleSubmit}
                loading={fetcher.state !== 'idle'}
                disabled={saveBlocked}
                data-testid="quiz-form-save"
              >
                {isEditing ? 'Update' : 'Create'}
              </Button>
            </Space>
          </div>
        }
      >
        <div
          style={{
            display: 'flex',
            height: 'calc(100vh - 110px)',
          }}
        >
          {/* Form Section */}
          <div
            style={{
              flex: showAssistant ? '0 0 50%' : 1,
              height: '100%',
              overflowY: 'auto',
              padding: '24px',
              borderRight: showAssistant
                ? `1px solid ${isDarkMode ? '#2d2d44' : '#e5e7eb'}`
                : 'none',
              transition: 'all 0.3s ease',
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: showAssistant ? '800px' : '1200px',
              }}
            >
              {saveError && (
                <Alert type="error" showIcon message={saveError} style={{ marginBottom: 16 }} />
              )}
              <Form
                form={form}
                layout="vertical"
                initialValues={{
                  ...(quiz ?? {
                    questionCount: 5,
                    maxAttempts: 1,
                    gradingStrategy: 'HIGHEST',
                    subject: '',
                    difficultyLevel: 'Beginner',
                    includeCodeContext: false,
                    excludedPaths: '',
                    sourceMaterial: [],
                    courseSearchEnabled: false,
                  }),
                  ...(canAuthor ? { assignment: panelFormValues(assignmentPanel) } : {}),
                }}
              >
                {/* Two columns on a wide screen (the quiz, then its Assignment
                    panel, as on board I1); one when the AI assistant shares
                    the drawer or the screen is narrow, the panel on top. The
                    panel comes first in the page, so the tab order follows
                    the narrow layout; on a wide screen it is placed last. */}
                <div
                  className={
                    showAssistant
                      ? 'flex flex-col gap-6'
                      : 'flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start'
                  }
                >
                  <div className={showAssistant ? '' : 'lg:order-last lg:sticky lg:top-0'}>
                    {canAuthor ? (
                      <EditableAssignmentPanel
                        modules={modules}
                        isOwner={isOwner}
                        classSlug={org}
                        closesError={closesError}
                      />
                    ) : (
                      <ReadOnlyAssignmentPanel data={assignmentPanel} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <Form.Item
                      name="name"
                      label="Quiz Name"
                      rules={[{ required: true, message: 'Please enter a quiz name' }]}
                    >
                      <Input placeholder="e.g., Week 1: JavaScript Basics Review" />
                    </Form.Item>

                    <Form.Item
                      name="repositoryId"
                      label="Quiz each student on their code from"
                      tooltip="With Code-Aware on, each student is quizzed on their own copy of this repository"
                    >
                      <Select placeholder="No repository" allowClear>
                        {assignments?.map((repository: { id: string; title: string }) => (
                          <Option key={repository.id} value={repository.id}>
                            {repository.title}
                          </Option>
                        ))}
                      </Select>
                    </Form.Item>

                    <Form.Item
                      name="sourceMaterial"
                      label="Source material"
                      extra="Questions are generated from these documents, in this order. Drafts are used once published."
                    >
                      <Select
                        mode="multiple"
                        showSearch
                        allowClear
                        optionFilterProp="label"
                        placeholder="Pick the pages and slide decks this quiz is about"
                        options={sourceMaterialSelectOptions}
                      />
                    </Form.Item>

                    <Form.Item
                      name="courseSearchEnabled"
                      label="Allow whole-course search"
                      valuePropName="checked"
                      extra="Lets the quiz look beyond the linked material to check whether the course covers something a student mentions."
                    >
                      <Switch checkedChildren="On" unCheckedChildren="Off" />
                    </Form.Item>

                    {/* Example Solution Repo (optional - for AI assistant code exploration) */}
                    <Form.Item
                      label="Example Solution Repository (Optional)"
                      tooltip="Provide a GitHub URL to an example solution. The AI Prompt Assistant can explore this code to generate more targeted prompts."
                      extra="Used by the AI Prompt Assistant to analyze code and generate context-aware quiz prompts"
                    >
                      <Input
                        value={exampleRepoUrl}
                        onChange={e => setExampleRepoUrl(e.target.value)}
                        placeholder="https://github.com/org/example-solution"
                      />
                    </Form.Item>

                    <Form.Item
                      name="includeCodeContext"
                      label="Code-Aware Quiz"
                      valuePropName="checked"
                      tooltip="Enable AI agent to analyze student's code submission and ask specific questions about their implementation. Requires a linked repository with student repositories."
                    >
                      <Switch checkedChildren="Enabled" unCheckedChildren="Disabled" />
                    </Form.Item>

                    {/* Only for a code-aware quiz. Read from the form's store, so it
                    is right on the first render of an edit, not only after it. */}
                    <Form.Item
                      noStyle
                      shouldUpdate={(prev, next) =>
                        prev.includeCodeContext !== next.includeCodeContext
                      }
                    >
                      {({ getFieldValue }) =>
                        getFieldValue('includeCodeContext') === true ? (
                          <Form.Item
                            name="excludedPaths"
                            label="Paths to exclude"
                            extra="One pattern per line, like .gitignore. The quiz never reads or quotes files that match."
                            rules={[{ validator: validateExcludedPaths }]}
                          >
                            <TextArea
                              autoSize={{ minRows: 3, maxRows: 10 }}
                              spellCheck={false}
                              placeholder={EXCLUDED_PATHS_PLACEHOLDER}
                            />
                          </Form.Item>
                        ) : null
                      }
                    </Form.Item>

                    {/* The number of questions, max attempts and grading strategy
                    are the owner's and teachers' to set: read-only for a
                    teaching assistant, and left out of its save. */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                      <Form.Item
                        name="questionCount"
                        label="Number of Questions"
                        rules={[
                          { required: true, message: 'Please enter the number of questions' },
                        ]}
                        tooltip="The number of questions the AI will ask before triggering assessment"
                      >
                        <Input
                          type="number"
                          placeholder="Enter number of questions (e.g., 5)"
                          min={1}
                          max={20}
                          disabled={!canAuthor}
                          data-testid="quiz-question-count"
                        />
                      </Form.Item>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                      {/* The per-attempt message limit, for a quiz whose attempts
                      run on the chat runtime. Read from the form's store, so
                      it is right on the first render of an edit. */}
                      <Form.Item
                        noStyle
                        shouldUpdate={(prev, next) =>
                          prev.includeCodeContext !== next.includeCodeContext ||
                          prev.repositoryId !== next.repositoryId
                        }
                      >
                        {({ getFieldValue }) => (
                          <Form.Item
                            name="maxAttempts"
                            label="Max Attempts"
                            rules={[{ required: true, message: 'Please enter maximum attempts' }]}
                            tooltip="Maximum number of attempts allowed. Set to 0 for unlimited attempts."
                            extra={
                              runsOnChatRuntime(chatRuntime, {
                                repositoryId: getFieldValue('repositoryId'),
                                includeCodeContext: getFieldValue('includeCodeContext'),
                              }) ? (
                                <span data-testid="quiz-form-message-limit">
                                  {QUIZ_MESSAGE_LIMIT_COPY.form(MAX_STUDENT_TURNS)}
                                </span>
                              ) : undefined
                            }
                          >
                            <Input
                              type="number"
                              placeholder="Enter max attempts (0 = unlimited)"
                              min={0}
                              max={10}
                              disabled={!canAuthor}
                              data-testid="quiz-max-attempts"
                            />
                          </Form.Item>
                        )}
                      </Form.Item>

                      <Form.Item
                        name="gradingStrategy"
                        label="Grading Strategy"
                        rules={[{ required: true, message: 'Please select a grading strategy' }]}
                        tooltip="How to calculate the final grade when students have multiple attempts"
                      >
                        <Select
                          placeholder="Select grading strategy"
                          disabled={!canAuthor}
                          data-testid="quiz-grading-strategy"
                        >
                          <Option value="HIGHEST">Highest Score</Option>
                          <Option value="MOST_RECENT">Most Recent</Option>
                          <Option value="FIRST">First Attempt Only</Option>
                        </Select>
                      </Form.Item>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                      <Form.Item
                        name="subject"
                        label="Subject"
                        rules={[{ required: true, message: 'Please enter the quiz subject' }]}
                        tooltip="The subject area for this quiz (e.g., JavaScript, React, Python)"
                      >
                        <Input placeholder="e.g., JavaScript Fundamentals" />
                      </Form.Item>

                      <Form.Item
                        name="difficultyLevel"
                        label="Difficulty Level"
                        rules={[{ required: true, message: 'Please select the difficulty level' }]}
                        tooltip="The difficulty level for this quiz"
                      >
                        <Select placeholder="Select difficulty level">
                          <Option value="Beginner">Beginner</Option>
                          <Option value="Intermediate">Intermediate</Option>
                          <Option value="Advanced">Advanced</Option>
                        </Select>
                      </Form.Item>
                    </div>

                    <Form.Item
                      label="Example Templates"
                      tooltip="Select an example to pre-populate prompts"
                    >
                      <Select
                        placeholder="Select an example template (optional)"
                        value={selectedExample}
                        onChange={handleExampleSelect}
                        allowClear
                        onClear={() => setSelectedExample('')}
                      >
                        {examplePrompts.map((example: { name: string; category: string }) => (
                          <Option key={example.name} value={example.name}>
                            {example.name} ({example.category})
                          </Option>
                        ))}
                      </Select>
                    </Form.Item>

                    <Form.Item
                      name="rubricPrompt"
                      label="Grading rubric"
                      rules={[{ required: true, message: 'Please enter a grading rubric' }]}
                      extra="How answers are graded. Put what the quiz covers in Source material."
                    >
                      <TextArea
                        autoSize={{ minRows: 8, maxRows: 20 }}
                        placeholder={`How to grade each answer, for example:

Full credit: explains the idea correctly, in their own words, with an example where one fits.
Partial credit: the right idea, but incomplete or with a small mistake.
No credit: incorrect, or restates the question without explaining it.

Weigh understanding over wording; don't penalize minor syntax slips.`}
                      />
                    </Form.Item>

                    <Form.Item
                      name="systemPrompt"
                      label="System Prompt (Optional)"
                      tooltip="Override defaults only if needed: question style preferences, tone adjustments, prerequisites, or special instructions. Leave empty for standard quiz behavior."
                    >
                      <TextArea
                        autoSize={{ minRows: 2, maxRows: 10 }}
                        placeholder="Leave empty for defaults, or specify: question style (code-focused, multiple choice, discussion), tone (stricter for exams), prerequisites, special allowances..."
                      />
                    </Form.Item>
                  </div>
                </div>
              </Form>
            </div>
          </div>

          {/* AI Assistant Panel - side by side with form */}
          {showAssistant && (
            <div
              className="assistant-panel"
              style={
                {
                  '--panel-bg': isDarkMode ? '#111827' : '#fafafa',
                  '--panel-border': isDarkMode ? '#374151' : '#d9d9d9',
                } as React.CSSProperties
              }
            >
              <PromptAssistant
                classroomSlug={org}
                formContext={formContext}
                exampleRepoUrl={exampleRepoUrl || null}
                onApplySuggestion={handleApplySuggestion}
                isDarkMode={isDarkMode}
                onClose={() => setShowAssistant(false)}
              />
            </div>
          )}
        </div>
      </Drawer>
    </ConfigProvider>
  );
}

export default QuizFormDrawer;
