import type { NavGroup, NavId, ShellUser } from '../types/app';

export const navTop: { id: NavId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'calendar', label: 'Calendar' },
];

export const navGroups: NavGroup[] = [
  {
    label: 'Content',
    items: [
      { id: 'modules', label: 'Modules' },
      { id: 'repositories', label: 'Repositories' },
      { id: 'quizzes', label: 'Quizzes' },
    ],
  },
  {
    label: 'Assessment',
    items: [
      { id: 'grades', label: 'Grades' },
      { id: 'resubmits', label: 'Resubmits' },
      { id: 'tokens', label: 'Tokens' },
    ],
  },
  {
    label: 'People',
    staffOnly: true,
    items: [
      { id: 'students', label: 'Students' },
      { id: 'staff', label: 'Teaching Staff' },
    ],
  },
];

export const demoUsers: Record<'teacher' | 'ta' | 'student', ShellUser> = {
  teacher: { name: 'Maya Rivera', handle: 'mrivera', initials: 'MR' },
  ta: { name: 'Sam Park', handle: 'sampark', initials: 'SP' },
  student: { name: 'Bob Kim', handle: 'bobkim', initials: 'BK' },
};
