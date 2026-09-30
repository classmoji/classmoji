import { useEffect, useState } from 'react';
import { Collapse, Typography } from 'antd';
import { FileTextOutlined, RocketOutlined, WarningOutlined } from '@ant-design/icons';
import type { QuizDataParts } from '@classmoji/utils/quiz-agent';

const { Text } = Typography;

/**
 * The files the quiz read in a reply (its `data-step` parts), under the legacy
 * chat's collapsed "Code Analysis (N steps)" header: the path of each file,
 * and nothing about why it was read. Open while the files are still being
 * read; collapsed once what they were read for has arrived. The student can
 * open and close it either way.
 */
export type QuizStep = QuizDataParts['step'];

interface StepListProps {
  steps: readonly QuizStep[];
  /** The files are still being read: show the list open. */
  active?: boolean;
  isDarkMode?: boolean;
}

const StepLine = ({ step }: { step: QuizStep }) => (
  <li className="flex items-center gap-2 py-1 text-xs">
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

/** The legacy header's wording, one step or many. */
export const stepsLabel = (count: number) =>
  `Code Analysis (${count} ${count === 1 ? 'step' : 'steps'})`;

function StepList({ steps, active = false, isDarkMode = false }: StepListProps) {
  const [open, setOpen] = useState(active);
  // Follows the reply: open while files are read, closed once they are done.
  useEffect(() => setOpen(active), [active]);

  if (steps.length === 0) return null;

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
                <RocketOutlined style={{ color: '#3b82f6' }} /> {stepsLabel(steps.length)}
              </Text>
            ),
            children: (
              <ul className="m-0 max-h-[200px] list-none overflow-y-auto p-0">
                {steps.map((step, i) => (
                  <StepLine key={`${step.path}-${i}`} step={step} />
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
