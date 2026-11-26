import { useMemo, useState } from 'react';
import { Table, Tag } from 'antd';
import { IconChevronDown, IconChevronRight, IconHash } from '@tabler/icons-react';

import AvatarGroup from './AvatarGroup';
import TeamThumbnailView from './TeamThumbnailView';
import TableActionButtons from '~/components/ui/buttons/TableActionButtons';

export interface TeamsTagTableMember {
  name?: string | null;
  login: string | null;
  avatar_url?: string | null;
  [key: string]: unknown;
}

export interface TeamsTagTableTeam {
  id: string;
  name: string;
  slug: string;
  avatar_url?: string | null;
  tags: Array<{ id: string; tag: { name: string } }>;
  memberships: Array<{ user: TeamsTagTableMember }>;
}

interface TeamsTagTableProps {
  teams: TeamsTagTableTeam[];
  emptyText: React.ReactNode;
  onView: (team: TeamsTagTableTeam) => void;
  onDelete: (team: TeamsTagTableTeam) => void;
}

interface TreeNode {
  key: string;
  kind: 'tag' | 'team';
  name: string;
  /** Tag rows: the teams under it. */
  teamCount?: number;
  team?: TeamsTagTableTeam;
  children?: TreeNode[];
}

const NO_TAG = '__no_tag__';

const TeamsTagTable = ({ teams, emptyText, onView, onDelete }: TeamsTagTableProps) => {
  const treeData: TreeNode[] = useMemo(() => {
    const byTag = new Map<string, TeamsTagTableTeam[]>();
    for (const team of teams) {
      // A team with several tags sits under each of them; one with none goes
      // in the last group.
      const names = team.tags.length ? team.tags.map(t => t.tag.name) : [NO_TAG];
      for (const name of new Set(names)) {
        byTag.set(name, [...(byTag.get(name) ?? []), team]);
      }
    }

    const names = [...byTag.keys()].sort((a, b) => {
      if (a === NO_TAG) return 1;
      if (b === NO_TAG) return -1;
      return a.localeCompare(b);
    });

    return names.map(tagName => {
      const tagTeams = byTag.get(tagName)!;
      return {
        key: `tag-${tagName}`,
        kind: 'tag' as const,
        name: tagName === NO_TAG ? 'No tags' : tagName,
        teamCount: tagTeams.length,
        children: tagTeams.map(team => ({
          // The same team can appear under several tags, so the tag is in its key.
          key: `team-${tagName}-${team.id}`,
          kind: 'team' as const,
          name: team.name,
          team,
        })),
      };
    });
  }, [teams]);

  // Tag rows open by default, the way the Repositories page reads best; what
  // the user collapses stays collapsed, and a tag added later arrives open.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const expandedRowKeys = treeData.filter(node => !collapsed.has(node.key)).map(node => node.key);

  // A team row is the same row the flat list had: thumbnail with its members'
  // names, its tags, the avatar preview and the actions.
  const columns = [
    {
      title: 'Team',
      key: 'name',
      render: (_: unknown, record: TreeNode) => {
        if (record.kind === 'team') return <TeamThumbnailView team={record.team!} />;
        return (
          <span className="inline-flex items-center gap-2 align-middle">
            <IconHash size={18} className="text-gray-400 shrink-0" />
            <span className="font-semibold text-ink-1">{record.name}</span>
          </span>
        );
      },
    },
    {
      title: 'Tags',
      key: 'tags',
      width: 200,
      render: (_: unknown, record: TreeNode) => {
        if (record.kind !== 'team') return null;
        const tags = record.team!.tags;
        if (tags.length == 0) return <span className="text-gray-500 italic">No tags</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {tags.map(tag => (
              <Tag key={tag.id} color="blue" className="mb-1">
                #{tag.tag.name}
              </Tag>
            ))}
          </div>
        );
      },
    },
    {
      title: 'Members',
      key: 'members',
      width: 140,
      render: (_: unknown, record: TreeNode) => {
        if (record.kind === 'tag') {
          const n = record.teamCount ?? 0;
          return (
            <span className="text-sm text-ink-3">
              {n} {n === 1 ? 'team' : 'teams'}
            </span>
          );
        }
        const users = record.team!.memberships.map(m => m.user);
        if (users.length == 0) return <span className="text-gray-500 italic">No members</span>;
        return (
          <div className="flex items-center gap-2">
            <AvatarGroup users={users} />
            <span className="text-sm text-gray-600">({users.length})</span>
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_: unknown, record: TreeNode) =>
        record.kind === 'team' ? (
          <TableActionButtons
            onView={() => onView(record.team!)}
            onDelete={() => onDelete(record.team!)}
            skipDeleteConfirm
          />
        ) : null,
    },
  ];

  return (
    <Table
      columns={columns}
      dataSource={treeData}
      rowKey="key"
      rowHoverable={false}
      size="middle"
      expandable={{
        expandedRowKeys,
        // The same chevron disclosure as the Repositories table. Team rows keep
        // the spacer so their thumbnails stay aligned.
        expandIcon: ({ expanded, onExpand, record, expandable }) =>
          expandable ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${record.name}`}
              onClick={e => {
                e.stopPropagation();
                onExpand(record, e);
              }}
              className="float-left mr-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded align-middle text-ink-3 transition-colors hover:bg-stone-100 hover:text-ink-1 dark:hover:bg-neutral-800"
            >
              {expanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
            </button>
          ) : (
            <span className="float-left mr-2 inline-block h-5 w-5 shrink-0" />
          ),
        onExpand: (expanded, record) =>
          setCollapsed(prev => {
            const next = new Set(prev);
            if (expanded) next.delete(record.key);
            else next.add(record.key);
            return next;
          }),
      }}
      scroll={{ x: 760 }}
      pagination={{
        pageSize: 25,
        showSizeChanger: true,
        showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} tags`,
      }}
      locale={{ emptyText }}
    />
  );
};

export default TeamsTagTable;
