/**
 * Defines the routes in the application.
 */

import {
  IconHome,
  IconCalendar,
  IconCheckSquare,
  IconModule,
  IconFile,
  IconArrowRotate,
  IconCoin,
  IconBook,
  IconSettings,
  IconPeople,
  IconDiamond,
  IconGithub,
  IconSparkle,
} from '@classmoji/ui-components';

type IconComponent = React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export interface RouteEntry {
  link: string;
  label: string;
  icon: IconComponent;
  roles: string[];
  isProTier?: boolean;
  tiers?: string[];
  category?: string;
}

/**
 * Sidebar grouping per redesign (Phase 3).
 * Groups align to design bundle `shell.jsx` — a top group, a course group,
 * and a footer. Role-aware lists; each string is a key into `routes` below.
 */
export const sidebarSections = {
  top: {
    STUDENT: ['dashboard', 'calendar', 'tasks'],
    OWNER: ['dashboard', 'calendar', 'students'],
    ASSISTANT: ['dashboard', 'calendar'],
  },
  course: {
    STUDENT: ['modules', 'quizzes', 'regrade-requests', 'tokens', 'syllabus'],
    OWNER: [
      'quizzes',
      'grading',
      'modules',
      'pages',
      'slides',
      'tokens',
      'syllabus',
      'teams',
      'assistants',
      'repositories',
    ],
    ASSISTANT: ['quizzes', 'grading', 'modules', 'regrade-requests'],
  },
  footer: ['settings'],
} as const;

/**
 * @deprecated Retained as a compatibility alias for any external importers.
 * Use `sidebarSections` instead — the new schema is role-aware.
 */
export const routeCategories = sidebarSections;

/**
 * Defines the routes and their corresponding details.
 */
export const routes: Record<string, RouteEntry> = {
  dashboard: {
    link: '/dashboard',
    label: 'Dashboard',
    icon: IconHome as IconComponent,
    roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
  },

  calendar: {
    link: '/calendar',
    label: 'Calendar',
    icon: IconCalendar as IconComponent,
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
  },

  tasks: {
    link: '/tasks',
    label: 'Tasks',
    icon: IconCheckSquare as IconComponent,
    roles: ['STUDENT'],
  },

  // Content
  modules: {
    link: '/modules',
    label: 'Modules',
    icon: IconModule as IconComponent,
    roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
    category: 'content',
  },
  slides: {
    link: '/slides',
    label: 'Slides',
    icon: IconFile as IconComponent,
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    category: 'content',
  },
  pages: {
    link: '/pages',
    label: 'Pages',
    icon: IconBook as IconComponent,
    roles: ['OWNER', 'TEACHER'],
    category: 'content',
  },
  resources: {
    link: '/resources',
    label: 'Link Resources',
    icon: IconFile as IconComponent,
    roles: ['OWNER', 'TEACHER'],
    category: 'content',
  },
  syllabus: {
    link: '/syllabus',
    label: 'Syllabus',
    icon: IconBook as IconComponent,
    roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
    category: 'content',
  },

  // Assessment
  quizzes: {
    link: '/quizzes',
    label: 'Assignments',
    icon: IconFile as IconComponent,
    roles: ['OWNER', 'STUDENT', 'ASSISTANT'],
    isProTier: true,
    category: 'assessment',
  },
  grades: {
    link: '/grades',
    label: 'Grades',
    icon: IconDiamond as IconComponent,
    roles: ['OWNER'],
    category: 'assessment',
  },
  grading: {
    link: '/grading',
    label: 'Grading',
    icon: IconSparkle as IconComponent,
    roles: ['OWNER', 'ASSISTANT'],
    category: 'assessment',
  },
  'regrade-requests': {
    link: '/regrade-requests',
    label: 'Resubmits',
    icon: IconArrowRotate as IconComponent,
    roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
    category: 'assessment',
  },

  // People
  students: {
    link: '/students',
    label: 'Roster',
    icon: IconPeople as IconComponent,
    roles: ['OWNER'],
    category: 'people',
  },
  teams: {
    link: '/teams',
    label: 'Teams',
    icon: IconPeople as IconComponent,
    roles: ['OWNER'],
    tiers: ['PRO'],
    isProTier: true,
    category: 'people',
  },
  assistants: {
    link: '/assistants',
    label: 'Assistants',
    icon: IconPeople as IconComponent,
    roles: ['OWNER'],
    isProTier: true,
    category: 'people',
  },

  // Integrations
  repositories: {
    link: '/repositories',
    label: 'Repositories',
    icon: IconGithub as IconComponent,
    roles: ['OWNER'],
    category: 'integrations',
  },

  // Tokens (assessment)
  tokens: {
    link: '/tokens',
    label: 'Tokens',
    icon: IconCoin as IconComponent,
    roles: ['OWNER', 'STUDENT'],
    isProTier: true,
    category: 'assessment',
  },

  // Settings
  settings: {
    link: '/settings/general',
    label: 'Class Settings',
    icon: IconSettings as IconComponent,
    roles: ['OWNER'],
    category: 'settings',
  },
};
