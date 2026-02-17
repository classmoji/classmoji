import { useEffect, useState, useMemo } from 'react';
import { useFetcher, useNavigate, useParams } from 'react-router';
import {
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
import { ClassmojiService } from '@classmoji/services';
import { PromptAssistant } from '~/components/quiz/PromptAssistant';

import './quiz-form.css';

const { TextArea } = Input;
const { Option } = Select;

export async function loader({ params, request }) {
  const { class: classSlug } = params;
  const url = new URL(request.url);
  const quizId = url.searchParams.get('quizId');

  // Dynamic import to keep server-side dependencies on the server only
  const { getExamplePrompts } = await import('@classmoji/services');

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'ADMIN_QUIZ_FORM',
    attemptedAction: quizId ? 'edit_quiz' : 'create_quiz',
  });

  // Fetch modules for linking
  const modules = await ClassmojiService.module.findByClassroomId(classroom.id);
  const examplePrompts = getExamplePrompts();

  // If editing, fetch the quiz data
  let quiz = null;
  if (quizId) {
    quiz = await ClassmojiService.quiz.findById(quizId);
    if (!quiz || quiz.classroom_id.toString() !== classroom.id.toString()) {
      throw new Response('Quiz not found', { status: 404 });
    }

    // Transform for frontend
    quiz = {
      id: quiz.id,
      name: quiz.name,
      moduleId: quiz.module_id?.toString() || null,
      systemPrompt: quiz.system_prompt,
      rubricPrompt: quiz.rubric_prompt,
      subject: quiz.subject || '',
      difficultyLevel: quiz.difficulty_level || 'Beginner',
      dueDate: quiz.due_date,
      status: quiz.status,
      weight: quiz.weight,
      questionCount: quiz.question_count || 5,
      maxAttempts: quiz.max_attempts ?? 1,
      gradingStrategy: quiz.grading_strategy || 'HIGHEST',
      includeCodeContext: quiz.include_code_context || false,
    };
  }

  return {
    org: classSlug,
    quiz,
    isEditing: Boolean(quizId),
    assignments: modules, // Keep variable name for backward compat with component
    examplePrompts,
  };
}

function QuizFormDrawer({ loaderData }) {
  const { org, quiz, isEditing, assignments, examplePrompts } = loaderData;
  const { opened, close } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const fetcher = useFetcher();

  const [form] = Form.useForm();
  const [selectedExample, setSelectedExample] = useState('');
  const [showAssistant, setShowAssistant] = useState(false);
  const [exampleRepoUrl, setExampleRepoUrl] = useState('');

  // Build form context for the assistant
  const formContext = useMemo(() => {
    const values = form.getFieldsValue();
    const linkedModule = assignments?.find(
      a => a.id?.toString() === values.moduleId?.toString()
    );

    return {
      name: values.name,
      subject: values.subject,
      difficultyLevel: values.difficultyLevel,
      questionCount: values.questionCount,
      includeCodeContext: values.includeCodeContext,
      module: linkedModule
        ? {
            title: linkedModule.title,
            template: linkedModule.template,
            issues: linkedModule.issues?.map(i => ({
              title: i.title,
              description: i.body,
            })),
          }
        : null,
    };
  }, [form, assignments]);

  // Handle applying suggestions from the assistant
  const handleApplySuggestion = suggestion => {
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
    if (['Beginner', 'Intermediate', 'Advanced'].includes(suggestion?.difficultyLevel)) {
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

  // Handle successful form submission
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      // If a new quiz was created, navigate to its detail page
      if (fetcher.data.quizId) {
        navigate(`/admin/${classSlug}/quizzes/${fetcher.data.quizId}`);
      } else {
        // For updates, just close the drawer
        close();
      }
    }
  }, [fetcher.state, fetcher.data, navigate, classSlug, close]);

  const handleExampleSelect = exampleName => {
    const example = examplePrompts.find(e => e.name === exampleName);
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
        _action: isEditing ? 'updateQuiz' : 'createQuiz',
        id: quiz?.id,
      };

      // Submit to parent route's action
      fetcher.submit(formData, {
        method: 'POST',
        action: `/admin/${classSlug}/quizzes`,
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
          action: `/admin/${classSlug}/quizzes`,
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
              borderRight: showAssistant ? `1px solid ${isDarkMode ? '#2d2d44' : '#e5e7eb'}` : 'none',
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
                name="moduleId"
                label="Linked Module (Optional)"
                tooltip="Optionally link this quiz to a specific module"
              >
                <Select placeholder="Select a module to link this quiz to (optional)" allowClear>
                  {assignments?.map(module => (
                    <Option key={module.id} value={module.id}>
                      {module.title}
                    </Option>
                  ))}
                </Select>
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
                tooltip="Enable AI agent to analyze student's code submission and ask specific questions about their implementation. Requires a linked module with student repositories."
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
                  {examplePrompts.map(example => (
                    <Option key={example.name} value={example.name}>
                      {example.name} ({example.category})
                    </Option>
                  ))}
                </Select>
              </Form.Item>

              <Form.Item
                name="rubricPrompt"
                label="Rubric Prompt"
                rules={[{ required: true, message: 'Please enter a rubric prompt' }]}
                tooltip="List the specific concepts and skills to assess. This is the primary content that guides the quiz questions."
              >
                <TextArea
                  autoSize={{ minRows: 8, maxRows: 20 }}
                  placeholder={`Core Concepts to Assess:

1. **[Topic 1]** - Understanding of [specific aspect]
2. **[Topic 2]** - Ability to [specific skill]
3. **[Topic 3]** - Application of [pattern/principle]`}
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
              style={{
                '--panel-bg': isDarkMode ? '#111827' : '#fafafa',
                '--panel-border': isDarkMode ? '#374151' : '#d9d9d9',
              }}
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
