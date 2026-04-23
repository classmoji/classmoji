import { NavLink, useLocation, Outlet, useParams } from 'react-router';
import { Button, Modal, Checkbox } from 'antd';
import { useState, useEffect } from 'react';
import { IconCopyX, IconLink } from '@tabler/icons-react';

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
import { ModulesScreen, buildModuleCards } from '~/components/features/modules';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'MODULES',
    action: 'view_modules',
  });

  const modules = await ClassmojiService.module.findByClassroomSlug(classSlug!);
  return { modules, classSlug: classSlug! };
};

const AdminModules = ({ loaderData }: Route.ComponentProps) => {
  const { pathname } = useLocation();
  const { class: classSlug } = useParams();
  const { modules, classSlug: loaderClassSlug } = loaderData;
  const { fetcher } = useGlobalFetcher();
  const [query, setQuery] = useState('');
  const { show, close, visible } = useDisclosure();
  const [unenrolledStudents, setUnenrolledStudents] = useState<Array<Record<string, unknown>>>([]);
  const [selectedStudents, setSelectedStudents] = useState<Array<Record<string, unknown>>>([]);
  const [repositories, setRepositories] = useState<string[]>([]);
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
      setRepositories(fetcherData.repositories || []);
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
      repositories.forEach(repository => {
        if (repository.includes(login)) {
          repositoriesToDelete.push({ name: repository });
        }
      });
    });

    fetcher!.submit(
      JSON.stringify({
        deleteFromGithub: false,
        repositories: repositoriesToDelete,
        classroomSlug: classSlug,
      }),
      {
        method: 'post',
        action: `/api/operation/?action=deleteRepositories`,
        encType: 'application/json',
      }
    );
  };

  const filtered = modules.filter((module: { title: string }) =>
    module.title.toLowerCase().includes(query.toLowerCase())
  );

  const moduleCards = buildModuleCards(
    filtered.map((m: { id: string; title: string; slug: string | null; assignments?: Array<{ id: string; student_deadline?: Date | string | null }> }) => ({
      id: m.id,
      title: m.title,
      slug: m.slug,
      assignments: (m.assignments ?? []).map(a => ({
        id: a.id,
        student_deadline: a.student_deadline ?? null,
      })),
    })),
    {
      rolePrefix: 'admin',
      classSlug: loaderClassSlug,
      classroomStart: null,
    }
  );

  return (
    <div className="relative">
      <Outlet />

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

      {fetcherData?.triggerSession?.numReposToDelete && (
        <TriggerProgress operation="DELETE_REPOS" validIdentifiers={['delete_repository']} />
      )}

      {(fetcherData?.triggerSession?.numReposToCreate ||
        fetcherData?.triggerSession?.numIssuesToCreate) && (
        <TriggerProgress
          operation="PUBLISH_OR_SYNC_ASSIGNMENT"
          validIdentifiers={[
            'gh-create_repository',
            'cf-create_repository',
            'gh-create_issue',
            'cf-create_issue',
            'gh-add_collaborator_to_repo',
          ]}
        />
      )}

      <ModulesScreen
        modules={moduleCards}
        headerActions={
          <RequireRole roles={['OWNER']}>
            <div className="flex gap-3">
              <SearchInput query={query} setQuery={setQuery} placeholder="Search by title" />
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
              <NavLink to={`${pathname}/form`}>
                <ButtonNew>New module</ButtonNew>
              </NavLink>
            </div>
          </RequireRole>
        }
      />
    </div>
  );
};

export { action } from './action';

export default AdminModules;
