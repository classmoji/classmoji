import { Radio } from 'antd';

import type { UngradedChoice as Choice } from '@classmoji/services';

const OPTIONS: Array<{ value: Choice; label: string; hint: string }> = [
  {
    value: 'reassign',
    label: 'Spread across other graders',
    hint: "Each goes to the least-loaded grader on its assignment, keeping a student's work with one grader where possible.",
  },
  {
    value: 'unassign',
    label: 'Unassign',
    hint: 'They are left without this grader, for you to assign later.',
  },
  {
    value: 'keep',
    label: 'Leave as is',
    hint: 'They stay assigned to this person, as before.',
  },
];

/**
 * The decision the remove dialog asks for when the person being removed is
 * grader on submissions that have no grade yet and will no longer be an
 * assistant or teacher here. Shown only when `count` > 0.
 */
const UngradedChoice = ({
  name,
  count,
  canReassign,
  value,
  onChange,
}: {
  name: string;
  count: number;
  /** false when nobody else is in the grader pool — reassign would unassign. */
  canReassign: boolean;
  value: Choice;
  onChange: (value: Choice) => void;
}) => (
  <div className="space-y-3">
    <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
      {name} is assigned {count} ungraded {count === 1 ? 'submission' : 'submissions'}.
    </p>
    <Radio.Group
      value={value}
      onChange={e => onChange(e.target.value)}
      className="flex flex-col gap-3"
    >
      {OPTIONS.map(option => {
        const disabled = option.value === 'reassign' && !canReassign;
        return (
          <Radio key={option.value} value={option.value} disabled={disabled}>
            <span className="text-sm text-gray-800 dark:text-gray-100">{option.label}</span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {disabled ? 'No other assistant or teacher is marked as a grader.' : option.hint}
            </span>
          </Radio>
        );
      })}
    </Radio.Group>
    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
      Graded submissions keep their grader.
    </p>
  </div>
);

export default UngradedChoice;
