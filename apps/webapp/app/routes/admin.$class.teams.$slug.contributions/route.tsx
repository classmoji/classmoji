import { useNavigate, useParams } from 'react-router';
import { useEffect, useState } from 'react';
import { Card, Drawer, Collapse, Tag, Empty, Alert } from 'antd';
import dayjs from 'dayjs';

import {
  aggregateForTeam,
  busFactor,
  ClassmojiService,
  type TeamRepoSnapshot,
} from '@classmoji/services';
import {
  Anomalies,
  BraidTimeline,
  BusFactorGauge,
  ContributorBreakdown,
  ContributorPies,
  type CommitRecord as UICommitRecord,
  type ContributorRecord as UIContributorRecord,
  type EligibleStudent,
} from '~/components/features/analytics';
import StatsCard from '~/components/shared/stats/StatsCard';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const slug = params.slug!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'view_team_contributions',
  });

  const team = await ClassmojiService.team.findBySlugAndClassroomId(slug, classroom.id);
  if (!team) {
    throw new Response('Team not found', { status: 404 });
  }

  const aggregate = await aggregateForTeam(team.id);

  // Students eligible for linking unmatched contributors (per-repo links are
  // reachable from the individual repo views; we still pass the list so the
  // ContributorBreakdown modal can render).
  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );
  const eligibleStudents: EligibleStudent[] = students.map((s) => ({
    id: s!.id,
    login: s!.login ?? null,
    name: s!.name ?? null,
  }));

  return {
    team: { id: team.id, name: team.name, slug: team.slug },
    aggregate,
    students: eligibleStudents,
  };
};

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function RepoSummaryRow({ snapshot }: { snapshot: TeamRepoSnapshot }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>Updated {dayjs(snapshot.fetched_at).fromNow()}</span>
        {snapshot.stale && <Tag color="warning">Stale</Tag>}
      </div>
      {snapshot.error && (
        <Alert
          type="error"
          showIcon
          message="Snapshot error"
          description={snapshot.error}
        />
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatsCard title="Commits">{formatNumber(snapshot.total_commits)}</StatsCard>
        <StatsCard title="Lines Added">
          <span className="text-green-600 dark:text-green-400">
            +{formatNumber(snapshot.total_additions)}
          </span>
        </StatsCard>
        <StatsCard title="Lines Deleted">
          <span className="text-red-600 dark:text-red-400">
            -{formatNumber(snapshot.total_deletions)}
          </span>
        </StatsCard>
        <StatsCard title="Contributors">
          {formatNumber(snapshot.contributors.length)}
        </StatsCard>
      </div>
      <div className="text-sm text-gray-600 dark:text-gray-300">
        <span className="font-semibold text-gray-800 dark:text-gray-100">PRs:</span>{' '}
        {snapshot.pr_summary.open} open · {snapshot.pr_summary.merged} merged ·{' '}
        {snapshot.pr_summary.closed} closed
      </div>
    </div>
  );
}

const TeamContributionsView = ({ loaderData }: Route.ComponentProps) => {
  const { team, aggregate, students } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(true);
  }, []);

  const handleClose = () => {
    setOpen(false);
    // Small delay to let close animation finish before nav.
    setTimeout(() => navigate(`/admin/${classSlug}/teams`), 150);
  };

  return (
    <Drawer
      title={
        <div
          className="flex flex-col"
          data-testid="team-contributions-title"
        >
          <span>Contributions · {team.name}</span>
          <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
            Aggregated across all team repositories
          </span>
        </div>
      }
      open={open}
      onClose={handleClose}
      width="60%"
      data-testid="team-contributions-drawer"
    >
      {!aggregate ? (
        <Card data-testid="team-contributions-empty">
          <Empty
            description={
              <span className="text-gray-500 dark:text-gray-400">
                No analytics snapshots yet for this team&apos;s repositories.
              </span>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6" data-testid="team-contributions-body">
          {/* Overview: pies + bus factor + braid */}
          <Card data-testid="team-contributions-overview">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1">
                <ContributorPies
                  contributors={
                    aggregate.contributors as unknown as UIContributorRecord[]
                  }
                />
              </div>
              <div className="lg:col-span-1 flex items-center justify-center">
                {(() => {
                  const bus = busFactor(
                    aggregate.contributors as unknown as UIContributorRecord[],
                  );
                  // Bus factor count = contributors NOT in the top-share holder
                  // only makes sense when >1; approximate as "contributors with
                  // at least 10% share" to mirror the design's integer count.
                  const total = aggregate.contributors.length;
                  const totalCommits = aggregate.contributors.reduce(
                    (s, c) => s + c.commits,
                    0,
                  );
                  let bf = 1;
                  if (total > 0 && totalCommits > 0) {
                    const share10 = aggregate.contributors.filter(
                      (c) => c.commits / totalCommits >= 0.1,
                    ).length;
                    bf = Math.max(1, share10);
                    // If the top contributor holds >70%, bus factor is 1
                    if (bus && bus.share > 0.7) bf = 1;
                  }
                  return (
                    <BusFactorGauge busFactor={bf} totalContributors={total} />
                  );
                })()}
              </div>
              <div className="lg:col-span-1">
                <BraidTimeline
                  commits={aggregate.commits as unknown as UICommitRecord[]}
                  contributors={
                    aggregate.contributors as unknown as UIContributorRecord[]
                  }
                  deadline={null}
                />
              </div>
            </div>
          </Card>

          <Card>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <StatsCard title="Repositories">
                {formatNumber(Object.keys(aggregate.snapshotsByRepoId).length)}
              </StatsCard>
              <StatsCard title="Total Commits">
                {formatNumber(aggregate.commits.length)}
              </StatsCard>
              <StatsCard title="Lines Added">
                <span className="text-green-600 dark:text-green-400">
                  +{formatNumber(aggregate.total_additions)}
                </span>
              </StatsCard>
              <StatsCard title="Contributors">
                {formatNumber(aggregate.contributors.length)}
              </StatsCard>
            </div>

            <Anomalies
              snapshot={{
                commits: aggregate.commits as unknown as UICommitRecord[],
                contributors:
                  aggregate.contributors as unknown as UIContributorRecord[],
                total_additions: aggregate.total_additions,
                total_deletions: aggregate.total_deletions,
              }}
              deadline={null}
            />

            <ContributorBreakdown
              commits={aggregate.commits as unknown as UICommitRecord[]}
              contributors={
                aggregate.contributors as unknown as UIContributorRecord[]
              }
              unmatched={aggregate.contributors
                .filter((c) => !c.user_id)
                .map((c) => ({ login: c.login, commits: c.commits }))}
              // Aggregate view has no single repo; link-to-student action from
              // this view is disabled because the POST target requires a
              // repository_id. Users can link from the per-repo analytics view.
              repositoryId=""
              students={students}
            />
          </Card>

          <div data-testid="per-repo-list">
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
              Per repository
            </div>
            <Collapse
              accordion
              items={Object.values(aggregate.snapshotsByRepoId).map((snap) => ({
                key: snap.repository_id,
                label: (
                  <div className="flex items-center justify-between">
                    <span
                      className="font-medium"
                      data-testid={`repo-label-${snap.repository_id}`}
                    >
                      {snap.repository_name}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {formatNumber(snap.total_commits)} commit
                      {snap.total_commits === 1 ? '' : 's'} ·{' '}
                      {formatNumber(snap.contributors.length)} contributor
                      {snap.contributors.length === 1 ? '' : 's'}
                    </span>
                  </div>
                ),
                children: <RepoSummaryRow snapshot={snap} />,
              }))}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
};

export default TeamContributionsView;
