import { FileTextOutlined, WarningOutlined } from '@ant-design/icons';
import type { QuizDataParts } from '@classmoji/utils/quiz-agent';

/**
 * The files the quiz read in a reply (its `data-step` parts): the path of each
 * file, and nothing about why it was read. Collapsed once the reply is done;
 * open while it is still coming.
 */
export type QuizStep = QuizDataParts['step'];

interface StepListProps {
  steps: readonly QuizStep[];
  /** The reply is still streaming: show the list open. */
  active?: boolean;
}

const StepLine = ({ step }: { step: QuizStep }) => (
  <li className="flex items-center gap-2 py-0.5 text-xs text-gray-600 dark:text-gray-400">
    {step.error ? (
      <WarningOutlined className="text-amber-500 dark:text-amber-400" />
    ) : (
      <FileTextOutlined className="text-emerald-600 dark:text-emerald-400" />
    )}
    <span className="font-mono break-all">
      {step.error ? `Couldn't read ${step.path}` : step.path}
    </span>
  </li>
);

function StepList({ steps, active = false }: StepListProps) {
  if (steps.length === 0) return null;
  const label = `Read ${steps.length} ${steps.length === 1 ? 'file' : 'files'}`;

  return (
    <details
      className="mb-2 w-full max-w-[70%] rounded-md border border-stone-200 bg-stone-50 px-3 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
      data-testid="quiz-steps"
      open={active}
    >
      <summary className="cursor-pointer select-none text-xs font-medium text-gray-500 dark:text-gray-400">
        {label}
      </summary>
      <ul className="mt-1 max-h-48 list-none overflow-y-auto p-0">
        {steps.map((step, i) => (
          <StepLine key={`${step.path}-${i}`} step={step} />
        ))}
      </ul>
    </details>
  );
}

export default StepList;
