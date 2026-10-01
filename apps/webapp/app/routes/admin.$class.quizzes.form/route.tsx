import { useEffect, useState, useMemo } from 'react';
import { useFetcher, useLocation, useNavigate, useParams } from 'react-router';
import { useCallout } from '@classmoji/ui-components';
import {
  Alert,
  Drawer,
  ConfigProvider,
  theme,
  Form,
  Input,
  Select,
  DatePicker,
  Button,
  Switch,
  Space,
  Tooltip,
} from 'antd';
import { RobotOutlined, DeleteOutlined, BulbOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useRouteDrawer, useDarkMode } from '~/hooks';
import { assertClassroomAccess } from '~/utils/helpers';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import { ClassmojiService } from '@classmoji/services';
import { PromptAssistant, type PromptSuggestion } from '~/components/quiz/PromptAssistant';
import { useGitWeb } from '~/hooks/useGitWeb';
import {
  fromPickerValue,
  pickerLabel,
  pickerOptions,
  toPickerValue,
  toPickerValues,
  type LinkedDoc,
  type PickerDoc,
} from './sourceMaterialPicker';

import type { Route } from './+types/route';

import './quiz-form.css';

const { TextArea } = Input;
const { Option } = Select;

export async function loader({ params, request }: Route.LoaderArgs) {
  const classSlug = params.class!;
  const url = new URL(request.url);
  const quizId = url.searchParams.get('quizId');

  // Dynamic import to keep server-side dependencies on the server only
  const { getExamplePrompts } = await import('@classmoji/services');

  const { userId: _userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'ADMIN_QUIZ_FORM',
    attemptedAction: quizId ? 'edit_quiz' : 'create_quiz',
  });

  if (!(await quizzesVisibleOrThrow(classroom.id))) {
    throw new Response('Not Found', { status: 404 });
  }

  // Fetch repositories for linking
  const repositories = await ClassmojiService.repository.findByClassroomId(classroom.id);
  const examplePrompts = getExamplePrompts();
  // Pages and reveal.js decks for the source-material picker (id, title, draft).
  const sourceMaterialOptions = await ClassmojiService.quizSourceMaterial.listSourceMaterialOptions(
    classroom.id
  );

  // If editing, fetch the quiz data
  let quiz = null;
  // The documents the quiz links now, which the picker must be able to name.
  let linked: ReadonlyArray<LinkedDoc> = [];
  if (quizId) {
    const found = await ClassmojiService.quiz.findById(quizId);
    if (!found || found.classroom_id.toString() !== classroom.id.toString()) {
      throw new Response('Quiz not found', { status: 404 });
    }
    linked = found.source_material;

    // Transform for frontend
    quiz = {
      id: found.id,
      name: found.name,
      repositoryId: found.repository_id?.toString() || null,
      systemPrompt: found.system_prompt,
      rubricPrompt: found.rubric_prompt,
      subject: found.subject || '',
      difficultyLevel: found.difficulty_level || 'Beginner',
      dueDate: found.due_date,
      status: found.status,
      weight: found.weight,
      questionCount: found.question_count || 5,
      maxAttempts: found.max_attempts ?? 1,
      gradingStrategy: found.grading_strategy || 'HIGHEST',
      includeCodeContext: found.include_code_context || false,
      // In material order, as picker values.
      sourceMaterial: toPickerValues(found.source_material),
      courseSearchEnabled: found.course_search_enabled,
    };
  }

  return {
    org: classSlug,
    quiz,
    isEditing: Boolean(quizId),
    assignments: repositories, // Keep variable name for backward compat with component
    examplePrompts,
    // What the classroom offers, plus any linked document it does not.
    sourceMaterialOptions: pickerOptions(sourceMaterialOptions, linked),
  };
}

function QuizFormDrawer({ loaderData }: Route.ComponentProps) {
  const { org, quiz, isEditing, assignments, examplePrompts, sourceMaterialOptions } = loaderData;
  const callout = useCallout();
  const { opened, close } = useRouteDrawer({});
  const web = useGitWeb();
  const { terms } = web;
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const fetcher = useFetcher();
  // Served under every prefix this route's gate allows (/admin, /teacher and /assistant).
  // The submit target matters as much as the links: posting to the other
  // prefix's list route would miss this drawer's parent action.
  const rolePrefix = useLocation().pathname.split('/')[1];

  const [form] = Form.useForm();
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
        dueDate: quiz.dueDate ? dayjs(quiz.dueDate) : null,
      });
    }
  }, [quiz, form]);

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
    form.validateFields().then(values => {
      const formData = {
        ...values,
        dueDate: values.dueDate ? values.dueDate.toISOString() : null,
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
    });
  };

  const handleDelete = () => {
    if (quiz?.id) {
      fetcher.submit(
        { _action: 'deleteQuiz', id: quiz.id },
        {
          method: 'POST',
          action: `/${rolePrefix}/${classSlug}/quizzes`,
          encType: 'application/json',
        }
      );
    }
  };

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
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
              {isEditing && (
                <Button type="primary" danger icon={<DeleteOutlined />} onClick={handleDelete}>
                  Delete
                </Button>
              )}
            </div>
            <Space>
              <Button onClick={close}>Cancel</Button>
              <Button type="primary" onClick={handleSubmit} loading={fetcher.state !== 'idle'}>
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
                maxWidth: '800px',
              }}
            >
              {saveError && (
                <Alert type="error" showIcon message={saveError} style={{ marginBottom: 16 }} />
              )}
              <Form
                form={form}
                layout="vertical"
                initialValues={
                  quiz
                    ? {
                        ...quiz,
                        dueDate: quiz.dueDate ? dayjs(quiz.dueDate) : null,
                      }
                    : {
                        weight: 0,
                        questionCount: 5,
                        maxAttempts: 1,
                        gradingStrategy: 'HIGHEST',
                        subject: '',
                        difficultyLevel: 'Beginner',
                        status: 'DRAFT',
                        includeCodeContext: false,
                        sourceMaterial: [],
                        courseSearchEnabled: false,
                      }
                }
              >
                <Form.Item
                  name="name"
                  label="Quiz Name"
                  rules={[{ required: true, message: 'Please enter a quiz name' }]}
                >
                  <Input placeholder="e.g., Week 1: JavaScript Basics Review" />
                </Form.Item>

                <Form.Item
                  name="repositoryId"
                  label={`Linked ${terms.Repo} (Optional)`}
                  tooltip={`Optionally link this quiz to a specific ${terms.repo}`}
                >
                  <Select
                    placeholder={`Select a ${terms.repo} to link this quiz to (optional)`}
                    allowClear
                  >
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
                  label={`Example Solution ${terms.Repo} (Optional)`}
                  tooltip={`Provide a ${web.label} URL to an example solution. The AI Prompt Assistant can explore this code to generate more targeted prompts.`}
                  extra="Used by the AI Prompt Assistant to analyze code and generate context-aware quiz prompts"
                >
                  <Input
                    value={exampleRepoUrl}
                    onChange={e => setExampleRepoUrl(e.target.value)}
                    placeholder={
                      web.isGitLab
                        ? 'https://gitlab.com/group/example-solution'
                        : 'https://github.com/org/example-solution'
                    }
                  />
                </Form.Item>

                <Form.Item
                  name="includeCodeContext"
                  label="Code-Aware Quiz"
                  valuePropName="checked"
                  tooltip={`Enable AI agent to analyze student's code submission and ask specific questions about their implementation. Requires a linked ${terms.repo} with student ${terms.repos}.`}
                >
                  <Switch checkedChildren="Enabled" unCheckedChildren="Disabled" />
                </Form.Item>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <Form.Item
                    name="weight"
                    label="Weight (%)"
                    rules={[{ required: true, message: 'Please enter the quiz weight' }]}
                    tooltip="Quizzes with 0% weight will display as 'Practice' to students and won't affect their grade"
                  >
                    <Input
                      type="number"
                      placeholder="Enter weight percentage (0-100)"
                      min={0}
                      max={100}
                    />
                  </Form.Item>

                  <Form.Item
                    name="questionCount"
                    label="Number of Questions"
                    rules={[{ required: true, message: 'Please enter the number of questions' }]}
                    tooltip="The number of questions the AI will ask before triggering assessment"
                  >
                    <Input
                      type="number"
                      placeholder="Enter number of questions (e.g., 5)"
                      min={1}
                      max={20}
                    />
                  </Form.Item>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <Form.Item
                    name="maxAttempts"
                    label="Max Attempts"
                    rules={[{ required: true, message: 'Please enter maximum attempts' }]}
                    tooltip="Maximum number of attempts allowed. Set to 0 for unlimited attempts."
                  >
                    <Input
                      type="number"
                      placeholder="Enter max attempts (0 = unlimited)"
                      min={0}
                      max={10}
                    />
                  </Form.Item>

                  <Form.Item
                    name="gradingStrategy"
                    label="Grading Strategy"
                    rules={[{ required: true, message: 'Please select a grading strategy' }]}
                    tooltip="How to calculate the final grade when students have multiple attempts"
                  >
                    <Select placeholder="Select grading strategy">
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

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <Form.Item name="dueDate" label="Due Date (Optional)">
                    <DatePicker
                      showTime
                      style={{ width: '100%' }}
                      placeholder="Select due date and time"
                    />
                  </Form.Item>

                  <Form.Item name="status" label="Status">
                    <Select>
                      <Option value="DRAFT">Draft</Option>
                      <Option value="PUBLISHED">Published</Option>
                      <Option value="ARCHIVED">Archived</Option>
                    </Select>
                  </Form.Item>
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
