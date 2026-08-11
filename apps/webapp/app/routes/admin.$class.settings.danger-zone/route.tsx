import { useEffect, useState } from 'react';
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

  const onRemoveClassroom = () => {
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
    if (fetcher?.state !== 'idle') return;
    if (fetcherData?.success) {
      navigate('/select-organization');
    } else if (fetcherData?.error) {
      setRemoving(false);
      close();
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
  // Best-effort — failures are reported, never block the classroom removal.
  let cleanupNote = '';
  if (deleteGitHub) {
    try {
      const summary = await ClassmojiService.classroom.deleteGitHubArtifacts(
        classroom.id,
        userToken ?? ''
      );
      const bits: string[] = [];
      if (summary.deleted_repos > 0)
        bits.push(`${summary.deleted_repos} repo${summary.deleted_repos === 1 ? '' : 's'}`);
      if (summary.deleted_teams > 0)
        bits.push(`${summary.deleted_teams} team${summary.deleted_teams === 1 ? '' : 's'}`);
      if (bits.length > 0) cleanupNote = ` GitHub: deleted ${bits.join(', ')}.`;
      if (summary.failures.length > 0) {
        console.error('GitHub cleanup failures on classroom delete:', summary.failures);
        cleanupNote += ` ${summary.failures.length} GitHub item${
          summary.failures.length === 1 ? '' : 's'
        } could not be deleted (see server logs).`;
      }
    } catch (error: unknown) {
      console.error('GitHub cleanup failed on classroom delete:', error);
      cleanupNote = ' GitHub cleanup failed — artifacts left in place (see server logs).';
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
