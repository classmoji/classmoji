import { App } from 'antd';
import { useNavigate, useParams } from 'react-router';

import { ActionTypes } from '~/constants';
import LocalStorage from '~/utils/localStorage';
import { useGlobalFetcher } from '~/hooks';

interface RepositoryRef {
  id: string;
  title: string;
}

/**
 * The repository actions every admin surface shares: publish / sync /
 * unpublish / delete through the repositories route's action (so the
 * TriggerProgress bar keyed on the global fetcher keeps working wherever the
 * table is rendered), plus navigation to the edit form and the repo-wide
 * operations (autograde, update student repos, contributions).
 * Confirmations use modal.confirm since antd Popconfirm doesn't compose inside
 * a Dropdown menu item.
 */
export const useRepositoryActions = (actionBase = '') => {
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { fetcher, notify } = useGlobalFetcher();
  const { modal } = App.useApp();

  const post = (action: string, id: string, method: 'post' | 'delete' = 'post') =>
    fetcher!.submit(
      { assignment_id: id },
      { method, action: `${actionBase}?/${action}`, encType: 'application/json' }
    );

  const publishRepository = (id: string) => {
    post('publish', id);
    LocalStorage.forceRefreshRepos();
  };
  const syncRepository = (id: string) => {
    post('sync', id);
    LocalStorage.forceRefreshRepos();
  };
  const unpublishRepository = (id: string) => post('unpublish', id);
  const deleteRepository = (id: string) => {
    notify(ActionTypes.DELETE_ASSIGNMENT, 'Deleting repository...');
    post('delete', id, 'delete');
    LocalStorage.forceRefreshRepos();
  };

  // Repo-wide operations that used to live on the repository detail page.
  const updateRepositories = (record: RepositoryRef) =>
    navigate(`/admin/${classSlug}/repos/update?id=${record.id}`);
  const autograde = (record: RepositoryRef) => {
    notify('AUTOGRADE_GIT_REPO_ASSIGNMENT', 'Provisioning autograding…');
    fetcher!.submit(
      { repositoryId: record.id, classroomSlug: classSlug! },
      {
        action: `/api/gitRepoAssignment/${classSlug}?/autograde`,
        method: 'post',
        encType: 'application/json',
      }
    );
  };
  const calculateContributions = (record: RepositoryRef) => {
    notify('CALCULATE_REPO_CONTRIBUTIONS', 'Calculating contributions…');
    post('calculateContributions', record.id);
  };
  const editRepository = (record: RepositoryRef) =>
    navigate(`/admin/${classSlug}/repos/form?title=${record.title}`, {
      state: { assignment: record },
    });

  const confirmSync = (id: string) =>
    modal.confirm({
      title: 'Sync repository',
      content: 'This updates all student repositories with the latest changes.',
      okText: 'Sync',
      cancelText: 'Cancel',
      onOk: () => syncRepository(id),
    });

  const confirmPublish = (id: string) =>
    modal.confirm({
      title: 'Publish repository',
      content: 'This makes the repository available to all students.',
      okText: 'Publish',
      cancelText: 'Cancel',
      onOk: () => publishRepository(id),
    });

  const confirmUnpublish = (id: string) =>
    modal.confirm({
      title: 'Unpublish repository',
      content: 'This hides the repository from students. Repositories are not deleted.',
      okText: 'Unpublish',
      cancelText: 'Cancel',
      onOk: () => unpublishRepository(id),
    });

  const confirmDelete = (id: string) =>
    modal.confirm({
      title: 'Delete repository',
      content: 'This permanently deletes the repository and its assignments.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => deleteRepository(id),
    });

  return {
    editRepository,
    updateRepositories,
    autograde,
    calculateContributions,
    confirmPublish,
    confirmSync,
    confirmUnpublish,
    confirmDelete,
  };
};
