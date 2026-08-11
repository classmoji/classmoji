import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal } from 'antd';

import { namedAction } from 'remix-utils/named-action';
import { useNavigate, useParams } from 'react-router';

import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { getAuthSession } from '@classmoji/auth/server';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

const DangerZone = () => {
  const { fetcher, notify } = useGlobalFetcher();
  const { show, close, visible } = useDisclosure();
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const [deleteGitHub, setDeleteGitHub] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Round-trip latch. The global fetcher is SHARED and self-resets to null data
  // right after it toasts a result, so "idle with no data" is ambiguous on its
  // own: it is the aborted case only once this submission has been seen in
  // flight, and only before its result was handled ('settled' — otherwise the
  // post-success reset would re-enter the effect and reopen the button).
  const phaseRef = useRef<'idle' | 'inflight' | 'settled'>('idle');

  const onRemoveClassroom = () => {
    phaseRef.current = 'idle';
    setRemoving(true);
    notify(
      ActionTypes.REMOVE_CLASSROOM,
      deleteGitHub ? 'Removing classroom and GitHub artifacts...' : 'Removing classroom...'
    );
    fetcher!.submit(
      { delete_github: deleteGitHub ? 'true' : 'false' },
      {
        method: 'delete',
        action: `?/removeClassroom`,
      }
    );
  };

  // Navigate only after the server confirms — a fire-and-forget navigate hid
  // failures entirely (the classroom would silently still exist). The success
  // toast (incl. the GitHub cleanup summary) comes from the global fetcher.
  const fetcherData = fetcher?.data as { success?: string; error?: string } | undefined;
  useEffect(() => {
    if (!removing) return;
    if (phaseRef.current === 'settled') return;
    if (fetcher?.state !== 'idle') {
      phaseRef.current = 'inflight';
      return;
    }
    if (phaseRef.current !== 'inflight') return;
    phaseRef.current = 'settled';
    if (fetcherData?.success) {
      navigate('/select-organization');
    } else if (fetcherData?.error) {
      setRemoving(false);
      close();
    } else {
      // Settled with neither outcome: the action never returned (aborted or
      // timed out). Un-stick the button but KEEP the modal open — the delete's
      // fate is unknown, so the user must decide whether to retry.
      setRemoving(false);
    }
  }, [removing, fetcher?.state, fetcherData, navigate, close]);

  return (
    <>
      <Modal
        title={`Remove ${classSlug} classroom`}
        open={visible}
        onOk={onRemoveClassroom}
        onCancel={() => close()}
        okText="Remove"
        okButtonProps={{ danger: true, loading: removing }}
        cancelButtonProps={{ disabled: removing }}
      >
        <p>
          Everything stored in Classmoji for this classroom will be permanently removed:
          repositories, assignments, quizzes, pages, slide decks, modules, student enrollments,
          grades, and settings. There is no undo.
        </p>
        <div className="pt-3">
          <Checkbox
            checked={deleteGitHub}
            disabled={removing}
            onChange={e => setDeleteGitHub(e.target.checked)}
          >
            Also delete this classroom&rsquo;s GitHub artifacts
            <div className="text-xs text-gray-500">
              The content repository, the classroom teams, and all student assignment repositories
              in the GitHub organization. Leave unchecked to keep everything on GitHub.
            </div>
          </Checkbox>
        </div>
        <p className="pt-3">Are you sure you want to proceed?</p>
      </Modal>
      <div>
        <p>Woah! I hope you know what you are doing.</p>
        <p className="pt-6 font-bold text-base">Remove Classroom </p>
        <p className="w-1/2 pb-4 pt-1">
          This action will remove the classroom and all its associated data. There is no going back.
        </p>
        <Button type="primary" danger onClick={show}>
          Remove
        </Button>
      </div>
    </>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'delete_classroom',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  // namedAction consumes the request body for the action name lookup only when
  // using search-param naming (?/removeClassroom) — the form data stays readable.
  const formData = await request.clone().formData();
  const deleteGitHub = formData.get('delete_github') === 'true';

  // The REQUESTER's GitHub token drives the cleanup (user-to-server: GitHub
  // enforces the human's own permissions per call). Never the app token.
  const authData = deleteGitHub ? await getAuthSession(request) : null;

  return namedAction(request, {
    async removeClassroom() {
      return removeClassroomHandler(classroom, deleteGitHub, authData?.token ?? null);
    },
  });
};

const removeClassroomHandler = async (
  classroom: { id: string },
  deleteGitHub: boolean,
  userToken: string | null
) => {
  // GitHub cleanup MUST precede the DB delete: the cascade destroys the rows
  // that name the artifacts (content repo, team slugs, git repo names).
  // A FAILED cleanup therefore ABORTS the delete — deleting anyway would strand
  // the surviving GitHub artifacts with nothing left in Classmoji naming them,
  // leaving manual cleanup as the only recourse. The user can fix permissions
  // and retry, or opt out of the GitHub cleanup entirely.
  let cleanupNote = '';
  if (deleteGitHub) {
    const retryHint =
      'Fix the GitHub permissions and try again, or uncheck the GitHub option to remove the classroom only.';
    let summary;
    try {
      summary = await ClassmojiService.classroom.deleteGitHubArtifacts(
        classroom.id,
        userToken ?? ''
      );
    } catch (error: unknown) {
      console.error('GitHub cleanup failed on classroom delete:', error);
      return {
        action: ActionTypes.REMOVE_CLASSROOM,
        error: `Classroom NOT deleted: GitHub cleanup failed (see server logs). ${retryHint}`,
      };
    }

    const bits: string[] = [];
    if (summary.deleted_repos > 0)
      bits.push(`${summary.deleted_repos} repo${summary.deleted_repos === 1 ? '' : 's'}`);
    if (summary.deleted_teams > 0)
      bits.push(`${summary.deleted_teams} team${summary.deleted_teams === 1 ? '' : 's'}`);
    const deletedNote = bits.length > 0 ? ` GitHub: deleted ${bits.join(', ')}.` : '';

    if (summary.failures.length > 0) {
      console.error('GitHub cleanup failures on classroom delete:', summary.failures);
      const failedNote = `${summary.failures.length} GitHub item${
        summary.failures.length === 1 ? '' : 's'
      } could not be deleted (see server logs).`;
      const progressNote =
        bits.length > 0
          ? ` Deleted before the failure: ${bits.join(', ')}.`
          : ' Nothing was deleted on GitHub.';
      return {
        action: ActionTypes.REMOVE_CLASSROOM,
        error: `Classroom NOT deleted: ${failedNote}${progressNote} ${retryHint}`,
      };
    }

    // `skipped` is already-gone / not-visible — never a reason to abort.
    cleanupNote = deletedNote;
    if (summary.skipped > 0) {
      cleanupNote += ` ${summary.skipped} item${
        summary.skipped === 1 ? ' was' : 's were'
      } already gone or not visible to your GitHub account.`;
    }
  }

  // The GitHub installation is never touched — multiple classrooms share it.
  await ClassmojiService.classroom.deleteById(classroom.id);
  return {
    action: ActionTypes.REMOVE_CLASSROOM,
    success: `Classroom removed successfully!${cleanupNote}`,
  };
};

export default DangerZone;
