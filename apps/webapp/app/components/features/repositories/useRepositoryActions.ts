import { App } from 'antd';
import { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { ActionTypes } from '~/constants';
import { FetcherContext } from '~/contexts';
import LocalStorage from '~/utils/localStorage';
import { useGlobalFetcher } from '~/hooks';
import { useGitWeb } from '~/hooks/useGitWeb';

interface RepositoryRef {
  id: string;
  title: string;
}

/**
 * The repository actions every admin surface shares: publish / sync /
 * unpublish / delete through the repositories route's action, plus navigation
 * to the edit form and the repo-wide operations (autograde, update student
 * repos, contributions).
 *
 * `pending` names the repository whose work is still going, so the row that
 * started it can say so in place. It covers the whole job, not just the
 * request: the action returns as soon as the Trigger.dev batch is queued, and
 * the repositories do not exist until that batch finishes.
 * Confirmations use modal.confirm since antd Popconfirm doesn't compose inside
 * a Dropdown menu item.
 */
export const useRepositoryActions = (actionBase = '') => {
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { fetcher, notify } = useGlobalFetcher();
  const { operation } = useContext(FetcherContext);
  const { modal } = App.useApp();
  const { terms } = useGitWeb();
  const [pending, setPending] = useState<{ id: string; label: string } | null>(null);

  // Done when the request has landed and no background batch came out of it.
  useEffect(() => {
    if (pending && fetcher!.state === 'idle' && !operation) setPending(null);
  }, [fetcher, fetcher!.state, operation, pending]);

  const post = (action: string, id: string, method: 'post' | 'delete' = 'post') =>
    fetcher!.submit(
      { assignment_id: id },
      { method, action: `${actionBase}?/${action}`, encType: 'application/json' }
    );

  const publishRepository = (id: string) => {
    setPending({ id, label: 'Publishing' });
    post('publish', id);
    LocalStorage.forceRefreshRepos();
  };
  const syncRepository = (id: string) => {
    setPending({ id, label: 'Syncing' });
    post('sync', id);
    LocalStorage.forceRefreshRepos();
  };
  const unpublishRepository = (id: string) => post('unpublish', id);

  /**
   * Publish one assignment. The action publishes its repository first when that
   * still needs provisioning, and leaves an already-published one alone.
   */
  const publishAssignment = (id: string) => {
    setPending({ id, label: 'Publishing' });
    post('publishAssignment', id);
    LocalStorage.forceRefreshRepos();
  };
  const deleteRepository = (id: string) => {
    notify(ActionTypes.DELETE_ASSIGNMENT, `Deleting ${terms.repo}...`);
    post('delete', id, 'delete');
    LocalStorage.forceRefreshRepos();
  };

  // Repo-wide operations that used to live on the repository detail page.
  const updateRepositories = (record: RepositoryRef) =>
    navigate(`/admin/${classSlug}/repos/update?id=${record.id}`);
  const autograde = (record: RepositoryRef) => {
    setPending({ id: record.id, label: 'Setting up' });
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
    setPending({ id: record.id, label: 'Calculating' });
    notify('CALCULATE_REPO_CONTRIBUTIONS', 'Calculating contributions…');
    post('calculateContributions', record.id);
  };
  const editRepository = (record: RepositoryRef) =>
    navigate(`/admin/${classSlug}/repos/form?title=${record.title}`, {
      state: { assignment: record },
    });

  const confirmSync = (id: string) =>
    modal.confirm({
      title: `Sync ${terms.repo}`,
      content: `This updates all student ${terms.repos} with the latest changes.`,
      okText: 'Sync',
      cancelText: 'Cancel',
      onOk: () => syncRepository(id),
    });

  const confirmPublish = (id: string) =>
    modal.confirm({
      title: `Publish ${terms.repo}`,
      content: `This makes the ${terms.repo} available to all students.`,
      okText: 'Publish',
      cancelText: 'Cancel',
      onOk: () => publishRepository(id),
    });

  /**
   * One button for "make this assignment work for students", whichever half is
   * outstanding: the assignment's own visibility, its repositories, or both.
   */
  const confirmPublishAssignment = (
    id: string,
    opts: { needsRepo: boolean; assignmentPublished: boolean }
  ) => {
    // Already open to students, but nobody has repositories yet.
    if (opts.assignmentPublished) {
      return modal.confirm({
        title: `Create student ${terms.repos}`,
        content: `This assignment is already open to students, but its ${terms.repos} have not been created. This creates them.`,
        okText: 'Create',
        cancelText: 'Cancel',
        onOk: () => publishAssignment(id),
      });
    }
    return modal.confirm({
      title: 'Publish assignment',
      content: opts.needsRepo
        ? `This creates the student ${terms.repos} first, then opens the assignment to students.`
        : `This opens the assignment to students. Its ${terms.repo} is already published.`,
      okText: 'Publish',
      cancelText: 'Cancel',
      onOk: () => publishAssignment(id),
    });
  };

  const confirmUnpublish = (id: string) =>
    modal.confirm({
      title: `Unpublish ${terms.repo}`,
      content: `This hides the ${terms.repo} from students. ${terms.Repos} are not deleted.`,
      okText: 'Unpublish',
      cancelText: 'Cancel',
      onOk: () => unpublishRepository(id),
    });

  const confirmDelete = (id: string) =>
    modal.confirm({
      title: `Delete ${terms.repo}`,
      content: `This permanently deletes the ${terms.repo} and its assignments.`,
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
    confirmPublishAssignment,
    confirmSync,
    confirmUnpublish,
    confirmDelete,
    pending,
  };
};
