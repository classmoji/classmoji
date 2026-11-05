import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Tooltip } from 'antd';
import { IconShieldPlus, IconShieldFilled } from '@tabler/icons-react';

// The module, not the barrel: '~/constants' also pulls in the nav's icons.
import { ActionTypes } from '~/constants/actionTypes';
import { useGlobalFetcher } from '~/hooks';
import useStore from '~/store';

interface LateShieldLabels {
  /** Shown on the button while the penalty applies (the click waives it). */
  add: string;
  /** Shown on the button while it is waived (the click restores it). */
  remove: string;
  /** The notice while the waiver is being set / cleared. */
  adding: string;
  removing: string;
}

interface LateShieldButtonProps {
  /** The penalty is waived now (server state). */
  overridden: boolean;
  /** Offer the shield at all: something is late or missing, or it is waived. */
  visible: boolean;
  /** The POST target. */
  action: string;
  /** The JSON body that sets the waiver to `value`. */
  body: (value: boolean) => Record<string, unknown>;
  actionType: string;
  labels: LateShieldLabels;
  /** Show the labels as a tooltip (the repo shield keeps its aria-label only). */
  tooltip?: boolean;
}

/**
 * The late shield: one click waives the late penalty, another restores it.
 * Shared by the repo submission shield and the quiz late waiver (#813).
 */
export const LateShieldButton = ({
  overridden,
  visible,
  action,
  body,
  actionType,
  labels,
  tooltip = false,
}: LateShieldButtonProps) => {
  const { fetcher, notify } = useGlobalFetcher();

  // The global fetcher round-trips twice per action (action + reset), each
  // revalidating loaders. Render an optimistic value until the server state
  // catches up so the icon flips exactly once instead of flashing.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  useEffect(() => {
    if (optimistic == null) return;
    const failed = Boolean((fetcher?.data as { error?: string } | undefined)?.error);
    if (overridden === optimistic || failed) {
      setOptimistic(null);
    }
  }, [overridden, fetcher?.data, optimistic]);

  const isOverridden = optimistic ?? overridden;

  const handleOverride = (message: string, value: boolean) => {
    setOptimistic(value);
    notify(actionType, message);

    fetcher!.submit(body(value) as never, {
      method: 'post',
      action,
      encType: 'application/json',
    });
  };

  if (!visible && !overridden && optimistic == null) return null;

  const label = isOverridden ? labels.remove : labels.add;
  const button = (
    <button
      type="button"
      aria-label={label}
      className="cursor-pointer inline-flex items-center"
      onClick={() => handleOverride(isOverridden ? labels.removing : labels.adding, !isOverridden)}
    >
      {isOverridden ? <IconShieldFilled size={16} /> : <IconShieldPlus size={16} />}
    </button>
  );
  return tooltip ? <Tooltip title={label}>{button}</Tooltip> : button;
};

interface LateOverrideRepositoryAssignment {
  id: string;
  is_late: boolean;
  is_late_override: boolean;
}

interface LateOverrideButtonProps {
  repositoryAssignment: LateOverrideRepositoryAssignment;
}

/** The repo submission's shield (`GitRepoAssignment.is_late_override`). */
const LateOverrideButton = ({ repositoryAssignment }: LateOverrideButtonProps) => {
  const { classroom } = useStore();
  return (
    <LateShieldButton
      overridden={repositoryAssignment.is_late_override}
      visible={repositoryAssignment.is_late}
      action={`/api/gitRepoAssignment/${classroom?.slug}?action=updateLateOverride`}
      body={value => ({
        git_repo_assignment_id: repositoryAssignment.id,
        is_late_override: value,
      })}
      actionType={ActionTypes.UPDATE_LATE_OVERRIDE}
      labels={{
        add: 'Add late override',
        remove: 'Remove late override',
        adding: 'Adding late override',
        removing: 'Removing late override',
      }}
    />
  );
};

/**
 * The quiz late waiver's shield (#813), for one student on one QUIZ
 * assignment: the repo shield's icons, with "Waive late penalty" / "Restore
 * late penalty". Render it only for owners and teachers where the classroom
 * takes changes; the server re-checks both.
 */
export const QuizLateWaiverButton = ({
  assignmentId,
  studentId,
  waived,
  visible,
}: {
  assignmentId: string;
  studentId: string;
  waived: boolean;
  /** The student is late or counted missing on the quiz (waived shows regardless). */
  visible: boolean;
}) => {
  const { classroom } = useStore();
  // The classroom in the URL (every page that offers this is under /:prefix/:class).
  const classSlug = useParams().class ?? classroom?.slug;
  return (
    <LateShieldButton
      overridden={waived}
      visible={visible}
      action={`/api/quizLateWaiver/${classSlug}`}
      body={value => ({ assignment_id: assignmentId, student_id: studentId, waived: value })}
      actionType={ActionTypes.UPDATE_QUIZ_LATE_WAIVER}
      labels={{
        add: 'Waive late penalty',
        remove: 'Restore late penalty',
        adding: 'Waiving late penalty',
        removing: 'Restoring late penalty',
      }}
      tooltip
    />
  );
};

export default LateOverrideButton;
