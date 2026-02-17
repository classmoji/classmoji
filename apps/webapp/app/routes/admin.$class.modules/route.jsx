import { NavLink, useLocation, Outlet, useParams } from 'react-router';
import { Button, Modal, Checkbox } from 'antd';
import { useState, useEffect } from 'react';
import { IconCopyX, IconLink } from '@tabler/icons-react';

import AssignmentTable from './AssignmentsTable';
import {
  SearchInput,
  ButtonNew,
  PageHeader,
  RequireRole,
  TriggerProgress,
  UserThumbnailView,
} from '~/components';
import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MODULES',
    action: 'view_modules',
  });

  const modules = await ClassmojiService.module.findByClassroomSlug(classSlug);
  return { modules };
};

const AdminAssignments = ({ loaderData }) => {
  const { pathname } = useLocation();
  const { class: classSlug } = useParams();
  const { modules } = loaderData;
  const { fetcher } = useGlobalFetcher();
  const [query, setQuery] = useState('');
  const { show, close, visible } = useDisclosure();
  const [unenrolledStudents, setUnenrolledStudents] = useState([]);
  const [selectedStudents, setSelectedStudents] = useState([]);
  const [repositories, setRepositories] = useState([]);

  useEffect(() => {
    if (!visible) {
      setUnenrolledStudents([]);
      setSelectedStudents([]);
    }
  }, [visible]);

  useEffect(() => {
    if (fetcher.data) {
      setUnenrolledStudents(fetcher.data.students);
      setRepositories(fetcher.data.repositories);
    }
  }, [fetcher.data]);

  const findUnenrolledStudents = () => {
    fetcher.submit(
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
    const loginNames = new Set(selectedStudents.map(({ login }) => login));

    const repositoriesToDelete = [];

    loginNames.forEach(login => {
      repositories.forEach(repository => {
        if (repository.includes(login)) {
          repositoriesToDelete.push({ name: repository });
        }
      });
    });

    fetcher.submit(
      {
        deleteFromGithub: false,
        repositories: repositoriesToDelete,
        classroomSlug: classSlug,
      },
      {
        method: 'post',
        action: `/api/operation/?action=deleteRepositories`,
        encType: 'application/json',
      }
    );
  };

  return (
    <div className="relative">
      <Outlet />
      <div className="flex justify-between items-start">
        <PageHeader title="Modules" routeName="modules" />

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
      </div>

      <Modal
        open={visible}
        className="max-h-[600px] overflow-y-scroll"
        title={
          fetcher.state !== 'idle'
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
        {fetcher.state === 'idle' && (
          <>
            {' '}
            <p>The following students are not on the roster:</p>
            <div className="flex flex-col gap-2 mt-6">
              {(unenrolledStudents || []).map(student => {
                const isSelected = selectedStudents.some(s => s.id === student.id);
                return (
                  <div
                    key={student.id}
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
                      <UserThumbnailView key={student.id} user={student} />
                    </Checkbox>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Modal>
      <>
        {fetcher.data?.triggerSession?.numReposToDelete && (
          <TriggerProgress operation="DELETE_REPOS" validIdentifiers={['delete_repository']} />
        )}

        {(fetcher.data?.triggerSession?.numReposToCreate ||
          fetcher.data?.triggerSession?.numIssuesToCreate) && (
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

        <AssignmentTable
          assignments={modules.filter(module =>
            module.title.toLowerCase().includes(query.toLowerCase())
          )}
        />
      </>
    </div>
  );
};

export { action } from './action';

export default AdminAssignments;
