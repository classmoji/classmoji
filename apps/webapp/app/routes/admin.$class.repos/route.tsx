import { NavLink, useLocation, Outlet, useParams } from 'react-router';
import { Button, Modal, Checkbox } from 'antd';
import { useState, useEffect } from 'react';
import { IconCopyX, IconLink } from '@tabler/icons-react';

import AssignmentTable from './AssignmentsTable';
import {
  SearchInput,
  ButtonNew,
  RequireRole,
  TriggerProgress,
  UserThumbnailView,
} from '~/components';
import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  const repositories = await ClassmojiService.repository.findByClassroomSlug(classSlug!);
  return { repositories };
};

const AdminAssignments = ({ loaderData }: Route.ComponentProps) => {
  const { pathname } = useLocation();
  const { class: classSlug } = useParams();
  const { repositories } = loaderData;
  const { fetcher } = useGlobalFetcher();
  const [query, setQuery] = useState('');
  const { show, close, visible } = useDisclosure();
  const [unenrolledStudents, setUnenrolledStudents] = useState<Array<Record<string, unknown>>>([]);
  const [selectedStudents, setSelectedStudents] = useState<Array<Record<string, unknown>>>([]);
  const [repoNames, setRepoNames] = useState<string[]>([]);
  const fetcherData = fetcher!.data as
    | {
        students?: Array<Record<string, unknown>>;
        repositories?: string[];
        triggerSession?: {
          numReposToDelete?: number;
          numReposToCreate?: number;
          numIssuesToCreate?: number;
        };
      }
    | undefined;

  useEffect(() => {
    if (!visible) {
      setUnenrolledStudents([]);
      setSelectedStudents([]);
    }
  }, [visible]);

  useEffect(() => {
    if (fetcherData) {
      setUnenrolledStudents(fetcherData.students || []);
      setRepoNames(fetcherData.repositories || []);
    }
  }, [fetcher!.data]);

  const findUnenrolledStudents = () => {
    fetcher!.submit(
      {
        action: 'FIND_UNENROLLED_STUDENTS',
      },
      {
        method: 'post',
        action: '?/findUnenrolledStudents',
        encType: 'application/json',
      }
    );
    show();
  };

  const deleteRepositories = () => {
    const loginNames = new Set(selectedStudents.map(s => s.login as string));

    const repositoriesToDelete: { name: string }[] = [];

    loginNames.forEach(login => {
      repoNames.forEach(repoName => {
        if (repoName.includes(login)) {
          repositoriesToDelete.push({ name: repoName });
        }
      });
    });

    fetcher!.submit(
      JSON.stringify({
        deleteFromGithub: false,
        repositories: repositoriesToDelete,
        classSlug,
      }),
      {
        method: 'post',
        action: `/api/operation/?action=deleteRepositories`,
        encType: 'application/json',
      }
    );
  };

  return (
    <div className="min-h-full relative">
      <Outlet />
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-base font-semibold text-ink-2">Repositories</h1>

        <RequireRole roles={['OWNER']}>
          <div className="flex items-center gap-3">
            <SearchInput
              query={query}
              setQuery={setQuery}
              placeholder="Search by title"
              className=""
            />

            <Button
              icon={<IconCopyX size={16} />}
              onClick={() => {
                findUnenrolledStudents();
              }}
            >
              Cleanup repos
            </Button>
            <NavLink to={`/admin/${classSlug}/resources`}>
              <Button icon={<IconLink size={16} />}>Link Resources</Button>
            </NavLink>
            <NavLink to={`${pathname}/form`} data-tour="repos-new">
              <ButtonNew>New repository</ButtonNew>
            </NavLink>
          </div>
        </RequireRole>
      </div>

      <Modal
        open={visible}
        className="max-h-[600px] overflow-y-scroll"
        title={
          fetcher!.state !== 'idle'
            ? 'Finding unenrolled students...'
            : 'List of unenrolled students'
        }
        onCancel={() => {
          close();
        }}
        footer={
          <div className="flex gap-2 justify-end">
            <Button onClick={close}>Close</Button>
            <Button
              disabled={selectedStudents.length === 0}
              onClick={() => {
                close();
                deleteRepositories();
                setUnenrolledStudents([]);
              }}
            >
              Remove repos
            </Button>
          </div>
        }
      >
        {fetcher!.state === 'idle' && (
          <>
            {' '}
            <p>The following students are not on the roster:</p>
            <div className="flex flex-col gap-2 mt-6">
              {(unenrolledStudents || []).map(student => {
                const isSelected = selectedStudents.some(s => s.id === student.id);
                return (
                  <div
                    key={student.id as string}
                    className={`rounded-md p-2 cursor-pointer ${isSelected ? 'bg-[#FFF0CC]' : ''}`}
                  >
                    <Checkbox
                      className="w-full"
                      onChange={e => {
                        setSelectedStudents(
                          e.target.checked
                            ? [...selectedStudents, student]
                            : selectedStudents.filter(s => s.id !== student.id)
                        );
                      }}
                    >
                      <UserThumbnailView key={student.id as string} user={student} />
                    </Checkbox>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Modal>
      <>
        {fetcherData?.triggerSession?.numReposToDelete && (
          <TriggerProgress operation="DELETE_REPOS" validIdentifiers={['delete_git_repo']} />
        )}

        {(fetcherData?.triggerSession?.numReposToCreate ||
          fetcherData?.triggerSession?.numIssuesToCreate) && (
          <TriggerProgress
            operation="PUBLISH_OR_SYNC_ASSIGNMENT"
            validIdentifiers={[
              'gh-create_git_repo',
              'cf-create_git_repo',
              'gh-create_git_repo_assignment',
              'cf-create_git_repo_assignment',
              'gh-add_collaborator_to_repo',
            ]}
          />
        )}

        <AssignmentTable
          assignments={repositories.filter((repository: { title: string }) =>
            repository.title.toLowerCase().includes(query.toLowerCase())
          )}
        />
      </>
    </div>
  );
};

export { action } from './action';

export default AdminAssignments;
