import { useEffect, useState } from 'react';
import { Collapse, Typography } from 'antd';
import { BookOutlined, FileTextOutlined, RocketOutlined, WarningOutlined } from '@ant-design/icons';
import type { QuizDataParts } from '@classmoji/utils/quiz-agent';

const { Text } = Typography;

/**
 * The work behind a reply (its `data-step` parts), under the legacy chat's
 * collapsed header: the files the quiz read ("Code Analysis (N steps)", the
 * path of each file) and the course material it looked up ("Checked course
 * material (N steps)", the title of each document read). Nothing about why:
 * a search shows the fixed label only. When every step is a course lookup the
 * header says so; any file read keeps the code-analysis header, as in the
 * legacy chat. Open while the work is still going on; collapsed once what it
 * was for has arrived. The student can open and close it either way.
 */
export type QuizStep = QuizDataParts['step'];

/** The legacy chat's label for a course-material step (a search's whole line). */
export const COURSE_STEP_LABEL = 'Checking course material';

interface StepListProps {
  steps: readonly QuizStep[];
  /** The work is still going on: show the list open. */
  active?: boolean;
  isDarkMode?: boolean;
}

export const isCourseStep = (step: QuizStep) => step.kind === 'course_material';

/** Every step looked up course material (and there is at least one). */
export const onlyCourseSteps = (steps: readonly QuizStep[]) =>
  steps.length > 0 && steps.every(isCourseStep);

const COURSE_COLOR = '#0d9488';

const StepLine = ({ step }: { step: QuizStep }) => {
  if (step.kind === 'course_material') {
    return (
      <li className="flex items-center gap-2 py-1 text-xs" data-step-kind="course_material">
        <BookOutlined style={{ color: COURSE_COLOR }} />
        <Text type="secondary" className="break-words" style={{ fontSize: '12px' }}>
          {step.title ?? COURSE_STEP_LABEL}
        </Text>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 py-1 text-xs" data-step-kind="read_file">
      {step.error ? (
        <WarningOutlined style={{ color: '#f59e0b' }} />
      ) : (
        <FileTextOutlined style={{ color: '#10b981' }} />
      )}
      <Text type="secondary" className="font-mono break-all" style={{ fontSize: '12px' }}>
        {step.error ? `Couldn't read ${step.path}` : step.path}
      </Text>
    </li>
  );
};

const stepCount = (count: number) => `${count} ${count === 1 ? 'step' : 'steps'}`;

/** The legacy header's wording, one step or many. */
export const stepsLabel = (count: number) => `Code Analysis (${stepCount(count)})`;

/** The legacy header for a reply whose steps only looked up course material. */
export const courseStepsLabel = (count: number) => `Checked course material (${stepCount(count)})`;

const stepKey = (step: QuizStep, i: number) =>
  `${step.kind === 'read_file' ? step.path : (step.title ?? '')}-${i}`;

function StepList({ steps, active = false, isDarkMode = false }: StepListProps) {
  const [open, setOpen] = useState(active);
  // Follows the reply: open while the work goes on, closed once it is done.
  useEffect(() => setOpen(active), [active]);

  if (steps.length === 0) return null;
  const course = onlyCourseSteps(steps);

  return (
    <div className="mb-2 w-full max-w-[70%]" data-testid="quiz-steps">
      <Collapse
        size="small"
        activeKey={open ? ['steps'] : []}
        onChange={keys => setOpen((Array.isArray(keys) ? keys : [keys]).includes('steps'))}
        items={[
          {
            key: 'steps',
            forceRender: true,
            label: (
              <Text type="secondary" style={{ fontSize: '12px' }}>
                {course ? (
                  <>
                    <BookOutlined style={{ color: COURSE_COLOR }} />{' '}
                    {courseStepsLabel(steps.length)}
                  </>
                ) : (
                  <>
                    <RocketOutlined style={{ color: '#3b82f6' }} /> {stepsLabel(steps.length)}
                  </>
                )}
              </Text>
            ),
            children: (
              <ul className="m-0 max-h-[200px] list-none overflow-y-auto p-0">
                {steps.map((step, i) => (
                  <StepLine key={stepKey(step, i)} step={step} />
                ))}
              </ul>
            ),
          },
        ]}
        style={{ width: '100%', backgroundColor: isDarkMode ? '#111827' : '#fafafa' }}
      />
    </div>
  );
}

export default StepList;
