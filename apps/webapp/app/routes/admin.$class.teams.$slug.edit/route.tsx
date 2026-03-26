import { useParams } from 'react-router';
import _ from 'lodash';
import { useState } from 'react';
import invariant from 'tiny-invariant';

import { Card, Button, Drawer, Table, Select, Tag } from 'antd';

import { useRouteDrawer, useGlobalFetcher } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { UserThumbnailView, TableActionButtons } from '~/components';
import { action } from './action';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const slug = params.slug!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'view_team_edit',
  });

  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );
  const studentsObjects = _.keyBy(students, 'login');

  const team = await ClassmojiService.team.findBySlugAndClassroomId(slug, classroom.id);
  const teamMembers = team!.memberships.map(({ user }) => user);
  const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);

  return { team, students: studentsObjects, teamMembers, tags };
};

const AdminSingleTeamView = ({ loaderData }: Route.ComponentProps) => {
  const { students, teamMembers, tags, team } = loaderData;
  const [membersToAdd, setMembersToAdd] = useState<string[]>([]);
  const [tagsToAdd, setTagsToAdd] = useState<string[]>([]);
  const { opened, close, open } = useRouteDrawer({});
  const { slug } = useParams();
  const { fetcher, notify } = useGlobalFetcher();

  const onAddStudents = () => {
    notify(ActionTypes.ADD_TEAM_MEMBER, 'Adding student(s) to team...');

    fetcher!.submit(
      { members: membersToAdd },
      {
        method: 'post',
        encType: 'application/json',
        action: '?/addMembersToTeam',
      }
    );
    setMembersToAdd([]);
  };

  const onRemoveStudent = (login: string) => {
    notify(ActionTypes.REMOVE_TEAM_MEMBER, 'Removing user from team...');

    fetcher!.submit(
      { login },
      {
        method: 'post',
        encType: 'application/json',
        action: '?/removeMemberFromTeam',
      }
    );
  };

  const onAddTags = () => {
    notify(ActionTypes.ADD_TEAM_TAG, 'Adding tag(s) to team...');

    fetcher!.submit(
      { teamId: team!.id, tags: tagsToAdd },
      { method: 'post', encType: 'application/json', action: '?/addTeamTags' }
    );

    setTagsToAdd([]);
  };

  const onRemoveTag = (id: string) => {
    notify(ActionTypes.REMOVE_TEAM_TAG, 'Removing tag from team...');

    fetcher!.submit(
      { id: id },
      {
        method: 'post',
        encType: 'application/json',
        action: '?/removeTeamTag',
      }
    );
  };

  const tagColumns = [
    {
      title: 'Name',
      dataIndex: ['tag', 'name'],
      key: 'name',
      width: '80%',

      render: (name: string) => <Tag>#{name}</Tag>,
    },
    {
      title: 'Action(s)',
      render: (tag: { id: string }) => {
        return <TableActionButtons onDelete={() => onRemoveTag(tag.id)} />;
      },
    },
  ];

  const studentColumns = [
    {
      title: 'Student',
      dataIndex: 'name',
      width: '80%',
      key: 'name',
      render: (_: unknown, student: { name: string | null; login: string | null; [key: string]: unknown }) => {
        return <UserThumbnailView user={student} />;
      },
    },
    {
      title: 'Action(s)',

      render: (_: unknown, student: { login: string | null }) => {
        return <TableActionButtons onDelete={() => onRemoveStudent(student.login ?? '')} />;
      },
    },
  ];

  return (
    <Drawer onClose={close} title={`@${slug}`} open={Boolean(open)} width="50%">
      <p className="pb-2 font-semibold text-xl">Tags</p>

      <Card className="mb-8 ">
        <div className="flex items-center gap-4">
          <Select
            className="w-full mt-2"
            mode="multiple"
            value={tagsToAdd}
            onChange={setTagsToAdd}
            options={tags
              .filter(tag => {
                return !team!.tags.map(t => t.tag_id).includes(tag.id);
              })
              .map(tag => {
                return { label: tag.name, value: tag.id };
              })}
          />

          <Button onClick={onAddTags}>Add</Button>
        </div>

        <Table
          columns={tagColumns}
          dataSource={team!.tags}
          rowHoverable={false}
          size="small"
          className="mt-4"
        />
      </Card>

      <p className="pb-2 font-semibold text-xl">Add team members</p>

      <Card>
        <div className="flex w-full items-end gap-4">
          <div className="w-full">
            <Select
              mode="multiple"
              className="w-full mt-2"
              placeholder="Search by student name"
              value={membersToAdd}
              onChange={setMembersToAdd}
              filterOption={(input, option) => {
                const allMembers = membersToAdd.concat(teamMembers.map(m => m.login ?? ''));
                return (
                  (option!.label as string).toLowerCase().includes(input.toLowerCase()) &&
                  allMembers.includes(option!.value as string) == false
                );
              }}
              options={Object.values(students)
                .map(student => {
                  return { label: student!.name ?? '', value: student!.login ?? '' };
                })
                .filter(option => !teamMembers.map(m => m.login).includes(option.value))}
              filterSort={(a, b) => (a.label as string).localeCompare(b.label as string)}
            />
          </div>
          <Button className="w-[10%]" onClick={onAddStudents}>
            Add
          </Button>
        </div>
        <Table
          columns={studentColumns}
          dataSource={teamMembers}
          className="mt-8"
          rowHoverable={false}
          size="small"
        />
      </Card>
    </Drawer>
  );
};

export { action };

export default AdminSingleTeamView;
