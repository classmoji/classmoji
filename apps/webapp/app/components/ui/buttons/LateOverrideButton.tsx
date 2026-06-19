import { useEffect, useState } from 'react';
import { IconShieldPlus, IconShieldFilled } from '@tabler/icons-react';

import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import useStore from '~/store';

interface LateOverrideRepositoryAssignment {
  id: string;
  is_late: boolean;
  is_late_override: boolean;
}

interface LateOverrideButtonProps {
  repositoryAssignment: LateOverrideRepositoryAssignment;
}

const LateOverrideButton = ({ repositoryAssignment }: LateOverrideButtonProps) => {
  const { fetcher, notify } = useGlobalFetcher();
  const { classroom } = useStore();

  // The global fetcher round-trips twice per action (action + reset), each
  // revalidating loaders. Render an optimistic value until the server state
  // catches up so the icon flips exactly once instead of flashing.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  useEffect(() => {
    if (optimistic == null) return;
    const failed = Boolean((fetcher?.data as { error?: string } | undefined)?.error);
    if (repositoryAssignment.is_late_override === optimistic || failed) {
      setOptimistic(null);
    }
  }, [repositoryAssignment.is_late_override, fetcher?.data, optimistic]);

  const isOverridden = optimistic ?? repositoryAssignment.is_late_override;

  const handleOverride = (message: string, value: boolean) => {
    setOptimistic(value);
    notify(ActionTypes.UPDATE_LATE_OVERRIDE, message);

    fetcher!.submit(
      {
        git_repo_assignment_id: repositoryAssignment.id,
        is_late_override: value,
      },
      {
        method: 'post',
        action: `/api/gitRepoAssignment/${classroom?.slug}?action=updateLateOverride`,
        encType: 'application/json',
      }
    );
  };

  if (
    repositoryAssignment.is_late == false &&
    repositoryAssignment.is_late_override == false &&
    optimistic == null
  )
    return null;

  return (
    <button
      type="button"
      aria-label={isOverridden ? 'Remove late override' : 'Add late override'}
      className="cursor-pointer"
      onClick={() =>
        handleOverride(
          isOverridden ? 'Removing late override' : 'Adding late override',
          !isOverridden
        )
      }
    >
      {isOverridden ? <IconShieldFilled size={16} /> : <IconShieldPlus size={16} />}
    </button>
  );
};

export default LateOverrideButton;
