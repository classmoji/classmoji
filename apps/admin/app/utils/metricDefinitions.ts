/**
 * Metric definitions shared by the server (metrics.server.ts) and the
 * browser (tooltips, range pickers). No Prisma here: route components may
 * import this file.
 */

export const METRIC_DEFINITIONS = {
  weeklyActiveInstructors:
    'Owners or teachers of a real classroom who used Classmoji themselves this week (Monday start). Impersonation never counts.',
  weeklyActiveStudents:
    'Students with an accepted membership in a real classroom who used Classmoji themselves this week.',
  newInstructors: 'People whose first sign-in was this week and who own or teach a real classroom.',
  activeClassrooms:
    'Not an example, not archived, status ACTIVE. Locked and unpublished classrooms are shown separately.',
  submissions:
    'Repository and issue submissions recorded this week (GitRepoAssignment.closed_at) in real classrooms.',
  askMoji:
    'Ask Moji conversations (not quiz chats) where a student or staff member, not an impersonator, sent a message this week.',
} as const;

export type KpiKey = keyof typeof METRIC_DEFINITIONS;

export type GrowthRange = '30d' | '12w' | '26w' | '52w';

export const GROWTH_RANGES: Record<
  GrowthRange,
  { unit: 'day' | 'week'; count: number; label: string }
> = {
  '30d': { unit: 'day', count: 30, label: '30 days' },
  '12w': { unit: 'week', count: 12, label: '12 weeks' },
  '26w': { unit: 'week', count: 26, label: '26 weeks' },
  '52w': { unit: 'week', count: 52, label: '1 year' },
};

export type GrowthSeries = 'instructors' | 'signups' | 'classrooms';

export const GROWTH_DEFINITIONS: Record<GrowthSeries, string> = {
  instructors: 'First sign-ins by people who own or teach a real classroom',
  signups: 'Everyone’s first sign-in (students included)',
  classrooms: 'Real classrooms created, including ones archived since',
};
