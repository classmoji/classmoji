import { Button, Tooltip } from 'antd';
import { IconLayoutKanban } from '@tabler/icons-react';
import { TableActionButtons } from '~/components';
import { useNotifiedFetcher } from '~/hooks';
import { removeCircularReferences } from '~/utils/helpers.client';
import { ActionTypes } from '~/constants';
import LocalStorage from '~/utils/localStorage';

const RowActions = ({ repo, org }) => {
  const { fetcher, notify } = useNotifiedFetcher();

  const deleteRepo = () => {
    const action = `${ActionTypes.DELETE_REPO}-${repo.name}`;

    notify(action, 'Deleting repository...');

    fetcher.submit(
      { repo: removeCircularReferences(repo), action },
      {
        method: 'post',
        action: '?/deleteRepo',
        encType: 'application/json',
      }
    );

    LocalStorage.forceRefreshRepos();
  };

  const repoUrl = `https://github.com/${org}/${repo.name}`;
  const projectUrl = repo.project_number
    ? `https://github.com/orgs/${org}/projects/${repo.project_number}`
    : null;

  return (
    <TableActionButtons
      onView={() => window.open(repoUrl, '_blank')}
      onDelete={() => deleteRepo(repo)}
      hideViewText
      hideDeleteText
    >
      {projectUrl && (
        <Tooltip title="Open Project">
          <Button
            type="text"
            size="small"
            icon={<IconLayoutKanban size={16} />}
            href={projectUrl}
            target="_blank"
          />
        </Tooltip>
      )}
    </TableActionButtons>
  );
};

export default RowActions;
