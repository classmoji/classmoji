import { useEffect } from 'react';
import { useFetcher } from 'react-router';
import { App } from 'antd';

/** What the assignments delete action reports when it left a repository empty. */
export interface OrphanedRepository {
  id: string;
  title: string;
}

/**
 * After deleting the last assignment of a published repository, offer to
 * unpublish it: students otherwise keep seeing a repository with nothing to
 * hand in. Unpublishing hides it; their repositories are kept.
 *
 * `result` is the delete fetcher's settled data. Each result asks once: a new
 * delete brings a new object.
 */
export const useOrphanedRepositoryPrompt = (
  result: { orphanedRepository?: OrphanedRepository | null } | undefined,
  classSlug: string | undefined
) => {
  const { modal } = App.useApp();
  const unpublish = useFetcher();
  const repository = result?.orphanedRepository;

  useEffect(() => {
    if (!repository || !classSlug) return;
    modal.confirm({
      title: `Unpublish ${repository.title}?`,
      content: 'It has no assignments left. Students still see it.',
      okText: 'Unpublish',
      cancelText: 'Keep',
      onOk: () =>
        unpublish.submit(JSON.stringify({ assignment_id: repository.id }), {
          method: 'post',
          action: `/admin/${classSlug}/repos?/unpublish`,
          encType: 'application/json',
        }),
    });
    // Keyed on the result: `modal` and `unpublish` are stable for its purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
};
