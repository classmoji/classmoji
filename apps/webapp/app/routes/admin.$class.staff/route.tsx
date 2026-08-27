import { useNavigate, useParams, Outlet } from 'react-router';
import { useState } from 'react';

import { IconUserSearch, IconTrash } from '@tabler/icons-react';
import { Table, Radio, Popconfirm, Modal, Tag } from 'antd';

import { authClient } from '@classmoji/auth/client';
import { ButtonNew, UserThumbnailView, SearchInput, TableActionButtons } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
export { action } from './action';
import FormStaff from './FormStaff';

import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ActionTypes } from '~/constants';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * The teaching staff spans three roles, and roles are additive — a membership is
 * unique on (classroom, user, role), so one person may hold more than one and
 * appears once per role they hold. Listed highest-first.
 */
const STAFF_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * A staff row as it leaves the loader — an EXPLICIT allowlist, and it must stay
 * one.
 *
 * This used to be `{ ...user, role }`, a raw spread of the whole User row, which
 * shipped email, provider_email, school_id, stripe_customer_id, banned,
 * ban_reason and ban_expires_at (plus the membership's letter_grade and comment)
 * to the browser. That was contained only because the page was OWNER-only; the
 * loader now reads at the teaching-team tier, so the payload is built field by
 * field instead. Note there is deliberately NO index signature here — an
 * `[key: string]: unknown` is what let the spread typecheck in the first place.
 *
 * Nothing on this screen needs a contact field, so unlike the roster there is no
 * owner-only branch: those keys are absent from EVERY viewer's payload,
 * including an owner's. Pinned by __tests__/staffRoster.test.ts.
 */
interface StaffMember {
  id: string;
  name: string | null;
  login: string | null;
  /**
   * The COMPUTED field from the Prisma result extension (packages/database),
   * derived from provider_id — never null, and not the same thing as the User
   * model's `image` column. `image` is written at sign-in, so a staff member who
   * has been invited but has not signed in yet has none; reading it here left
   * every fresh invite with a blank thumbnail.
   */
  avatar_url: string;
  role: StaffRole;
  is_grader: boolean;
  has_accepted_invite: boolean;
}

const ROLE_LABEL: Record<StaffRole, { label: string; color: string }> = {
  OWNER: { label: 'Owner', color: 'purple' },
  TEACHER: { label: 'Teacher', color: 'blue' },
  ASSISTANT: { label: 'Assistant', color: 'cyan' },
};

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Seeing who is on the teaching staff is a teaching-team right: an assistant
  // needs to know who to ask, and a teacher needs to know who is grading. The
  // MUTATIONS in this route stay OWNER-only and carry their own gate — see
  // ./action.ts. A layout loader never gates a leaf action, so widening this
  // read must not be read as widening anything else.
  const { classroom, membership } = await requireClassroomTeachingTeam(request, classSlug, {
    resourceType: 'TEACHING_STAFF',
    action: 'view_staff',
  });

  // Management authority is derived HERE, from role AND path — never from the
  // client-side role store, which is seeded from the URL prefix and is
  // cosmetic. `membership.role` is the caller's HIGHEST role in this classroom
  // (assertClassroomAccess resolves it in privilege order).
  const isOwner = membership?.role === 'OWNER';

  // The same loader serves /assistant/:class/staff and /teacher/:class/staff,
  // which export no `action` and have no nested detail route. An owner who
  // hand-types one of those URLs must not be shown controls that would post to
  // a route with no action (405) or open a drawer route that does not exist
  // (404). NARROWING ONLY: the prefix can subtract authority, never add it.
  const isAdminPrefix = new URL(request.url).pathname.startsWith('/admin/');
  const canManage = isOwner && isAdminPrefix;

  // One query per role rather than findUsersByRoles: that helper de-duplicates
  // by user id and drops the role, and this screen needs the role on every row.
  const staffByRole = await Promise.all(
    STAFF_ROLES.map(async role =>
      (await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, role)).map(
        (user): StaffMember => ({
          id: user.id,
          name: user.name,
          login: user.login,
          // The cast is the price of the result extension: packages/database
          // re-casts the `$extends` client back to a plain PrismaClient, so the
          // computed fields it adds are invisible to the static type. The field
          // is there at runtime for every User row.
          avatar_url: (user as typeof user & { avatar_url: string }).avatar_url,
          role,
          is_grader: user.is_grader,
          has_accepted_invite: user.has_accepted_invite,
        })
      )
    )
  );

  return { staff: staffByRole.flat(), canManage };
};

const AdminStaff = ({ loaderData }: Route.ComponentProps) => {
  const { staff, canManage } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { show, close, visible } = useDisclosure();
  const [query, setQuery] = useState('');
  const [impersonating, setImpersonating] = useState(false);
  const callout = useCallout();

  const handleImpersonate = async (member: StaffMember) => {
    if (!member.login) {
      callout.show({ variant: 'error', title: 'This staff member has not accepted their invite.' });
      return;
    }

    setImpersonating(true);
    try {
      const { data: _data, error } = await authClient.admin.impersonateUser({
        userId: member.id.toString(),
      });

      if (error) {
        throw new Error(error.message || 'Failed to view as this staff member');
      }

      // Land on the prefix that matches the role being viewed, exactly as the
      // detail drawer does — a teacher dropped on /assistant would be looking
      // at the wrong shell.
      const prefix = member.role === 'TEACHER' ? 'teacher' : 'assistant';
      navigate(`/${prefix}/${classSlug}/dashboard`);
    } catch (error: unknown) {
      console.error('Impersonation failed:', error);
      callout.show({
        variant: 'error',
        title: error instanceof Error ? error.message : 'Failed to view as this staff member',
      });
    } finally {
      setImpersonating(false);
    }
  };

  // The grader flag lives on ONE membership row, so the role has to travel with
  // the login — a user who is both TEACHER and ASSISTANT here has two rows and
  // the service refuses to guess which one is meant.
  const updateGraderFlag = (member: StaffMember, isGrader: boolean) => {
    notify(ActionTypes.SAVE_USER, 'Updating staff member...');

    fetcher!.submit(
      { login: member.login, role: member.role, isGrader },
      {
        method: 'put',
        action: '?/updateStaff',
        encType: 'application/json',
      }
    );
  };

  // Only the login and the role — the row itself is not the server's input.
  const removeStaffMember = (member: StaffMember) => {
    notify(ActionTypes.REMOVE_USER, 'Removing staff member...');
    fetcher!.submit(
      { login: member.login, role: member.role },
      {
        method: 'delete',
        action: '?/removeStaff',
        encType: 'application/json',
      }
    );
  };

  const filteredStaff = !query
    ? staff
    : staff.filter(
        (member: StaffMember) =>
          member.name?.toLowerCase().includes(query.toLowerCase()) ||
          member?.login?.toLowerCase().includes(query.toLowerCase())
      );

  const columns = [
    {
      title: 'Teaching staff',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (_: unknown, member: StaffMember) => {
        return <UserThumbnailView user={member} />;
      },
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      width: 120,
      render: (_: unknown, member: StaffMember) => {
        const { label, color } = ROLE_LABEL[member.role];
        return (
          <Tag color={color} className="font-semibold">
            {label}
          </Tag>
        );
      },
    },
    {
      title: 'Grader Role',
      dataIndex: 'is_grader',
      key: 'is_grader',
      width: 130,
      render: (_: unknown, member: StaffMember) => {
        // is_grader is only meaningful for the roles that grade — the RANDOM
        // grader pool draws from ASSISTANT and TEACHER rows, and the service
        // refuses the flag on an OWNER membership (grader_flag_invalid). So the
        // toggle simply does not exist on an owner row.
        if (member.role === 'OWNER') {
          return <span className="text-gray-400 dark:text-gray-500">—</span>;
        }
        if (!canManage) {
          return (
            <span className="text-gray-600 dark:text-gray-300">
              {member.is_grader ? 'Yes' : 'No'}
            </span>
          );
        }
        return (
          <Radio.Group
            onChange={e => updateGraderFlag(member, e.target.value)}
            defaultValue={member.is_grader}
            size="small"
          >
            <Radio value={true}>Yes</Radio>
            <Radio value={false}>No</Radio>
          </Radio.Group>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'has_accepted_invite',
      key: 'has_accepted_invite',
      width: 110,
      render: (_: unknown, member: StaffMember) => {
        return member.has_accepted_invite ? (
          <Tag color="green" className="font-semibold">
            Active
          </Tag>
        ) : (
          <Tag color="orange" className="font-semibold">
            Pending
          </Tag>
        );
      },
    },
    // The whole actions column is dropped for a viewer who may not act: every
    // control in it posts to this route's OWNER-only action or opens the
    // OWNER-only detail drawer.
    ...(canManage
      ? [
          {
            title: 'Actions',
            dataIndex: 'actions',
            key: 'actions',
            width: 200,
            render: (_: unknown, member: StaffMember) => {
              return (
                <TableActionButtons
                  // The detail drawer is a grading-progress view, so it is
                  // offered for the roles that grade only.
                  onView={
                    member.role === 'OWNER'
                      ? undefined
                      : () => {
                          if (member.login) {
                            navigate(`/admin/${classSlug}/staff/${member.login}`);
                          } else {
                            callout.show({
                              variant: 'error',
                              title: 'This staff member has not accepted their invite.',
                            });
                          }
                        }
                  }
                >
                  {/* Same roles the drawer offers it for: an owner viewing as
                      another owner would be looking at their own shell, and
                      the impersonation prefix only has an assistant and a
                      teacher form. */}
                  {member.role !== 'OWNER' && (
                    <div
                      onClick={e => {
                        e.stopPropagation();
                        if (!impersonating) {
                          handleImpersonate(member);
                        }
                      }}
                      className={`flex items-center gap-1 text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer ${impersonating ? 'opacity-50' : ''}`}
                    >
                      <IconUserSearch size={16} />
                      <span>View as</span>
                    </div>
                  )}
                  <Popconfirm
                    title={`Remove ${ROLE_LABEL[member.role].label}`}
                    description={
                      member.role === 'OWNER'
                        ? 'Remove this person as a co-owner of this classroom? Their other roles here, if any, are untouched.'
                        : 'Are you sure you want to remove this staff member? This action cannot be undone.'
                    }
                    onConfirm={() => removeStaffMember(member)}
                    okButtonProps={{ danger: true }}
                    okText="Remove"
                    cancelText="Cancel"
                  >
                    <div className="flex items-center gap-1 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 cursor-pointer">
                      <IconTrash size={16} />
                      <span>Remove</span>
                    </div>
                  </Popconfirm>
                </TableActionButtons>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <div className="min-h-full relative">
      <Outlet />

      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 shrink-0">Teaching Staff</h1>

        <div className="flex gap-3 min-w-0">
          <SearchInput
            query={query}
            setQuery={setQuery}
            placeholder="Search teaching staff..."
            className="min-w-0 flex-1 sm:flex-initial sm:w-80"
          />
          {canManage && (
            <span data-tour="staff-new" className="shrink-0">
              <ButtonNew action={show}>New staff member</ButtonNew>
            </span>
          )}
        </div>
      </div>

      {canManage && (
        <Modal
          title="Add Teaching Staff"
          open={visible}
          onOk={close}
          onCancel={close}
          footer={null}
          className="rounded-lg"
        >
          <FormStaff close={close} />
        </Modal>
      )}

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <Table
          columns={columns}
          dataSource={filteredStaff}
          // A person holding two roles here has one row per role, so the user id
          // alone is not unique across the table.
          rowKey={(member: StaffMember) => `${member.id}-${member.role}`}
          rowHoverable={false}
          pagination={{
            pageSize: 25,
            showSizeChanger: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} staff`,
          }}
          size="middle"
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: query ? (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">
                  No teaching staff found matching &ldquo;{query}&rdquo;
                </div>
                <div className="text-sm">Try adjusting your search terms</div>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No teaching staff added yet</div>
                <div className="text-sm">Add your first staff member to get started!</div>
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
};

export default AdminStaff;
