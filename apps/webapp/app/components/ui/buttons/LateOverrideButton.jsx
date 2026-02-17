import { IconShieldPlus, IconShieldFilled } from '@tabler/icons-react';

import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import useStore from '~/store';

const LateOverrideButton = ({ repositoryAssignment }) => {
  const { fetcher, notify } = useGlobalFetcher();
  const { classroom } = useStore(state => state);

  const handleOverride = (message, value) => {
    notify(ActionTypes.UPDATE_LATE_OVERRIDE, message);

    fetcher.submit(
      {
        repository_assignment_id: repositoryAssignment.id,
        is_late_override: value,
      },
      {
        method: 'post',
        action: `/api/repositoryAssignment/${classroom?.slug}?action=updateLateOverride`,
        encType: 'application/json',
      }
    );
  };

  if (repositoryAssignment.is_late == false && repositoryAssignment.is_late_override == false) return null;

  return (
    <div className="cursor-pointer">
      {repositoryAssignment.is_late_override == false && (
        <div>
          <IconShieldPlus size={16} onClick={() => handleOverride('Adding late override', true)} />
        </div>
      )}

      {repositoryAssignment.is_late_override == true && (
        <div>
          <IconShieldFilled
            size={16}
            onClick={() => handleOverride('Remove late override', false)}
          />
        </div>
      )}
    </div>
  );
};

export default LateOverrideButton;
