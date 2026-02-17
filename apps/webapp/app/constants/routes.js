/**
 * Defines the routes in the application.
 */

import {
  IconLayoutDashboard,
  IconFileText,
  IconUsers,
  IconUserCheck,
  IconSettings,
  IconUsersGroup,
  IconNumber,
  IconBrandGithub,
  IconCoin,
  IconRotate,
  IconRobot,
  IconPresentation,
  IconBook,
  IconCalendar,
  IconLink,
  IconChecklist,
} from '@tabler/icons-react';

/**
 * Route categories for organized navigation
 */
export const routeCategories = {
  content: {
    label: 'Content',
    items: ['modules', 'slides', 'pages', 'quizzes'],
  },
  assessment: {
    label: 'Assessment',
    items: ['grades', 'grading', 'regrade-requests', 'tokens'],
  },
  people: {
    label: 'People',
    items: ['students', 'teams', 'assistants'],
  },
  integrations: {
    label: 'Integrations',
    items: ['repositories'],
  },
  settings: {
    label: 'Settings',
    items: ['settings'],
  },
};

/**
 * Defines the routes and their corresponding details.
 */
export const routes = {
  dashboard: {
    link: '/dashboard',
    label: 'Dashboard',
    icon: IconLayoutDashboard,
    roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
  },

  // Calendar - shown under dashboard
  calendar: {
    link: '/calendar',
    label: 'Calendar',
    icon: IconCalendar,
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
  },

  // Content
  modules: {
    link: '/modules',
    label: 'Modules',
    icon: IconFileText,
    roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
    category: 'content',
  },
  slides: {
    link: '/slides',
    label: 'Slides',
    icon: IconPresentation,
    roles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    category: 'content',
  },
  pages: {
    link: '/pages',
    label: 'Pages',
    icon: IconBook,
    roles: ['OWNER', 'TEACHER'],
    category: 'content',
  },
  resources: {
    link: '/resources',
    label: 'Link Resources',
    icon: IconLink,
    roles: ['OWNER', 'TEACHER'],
    category: 'content',
  },

  // Assessment
  quizzes: {
    link: '/quizzes',
    label: 'Quizzes',
    icon: IconRobot,
    roles: ['OWNER', 'STUDENT', 'ASSISTANT'],
    isProTier: true,
    category: 'assessment',
  },
  grades: {
    link: '/grades',
    label: 'Grades',
    icon: IconNumber,
    roles: ['OWNER'],
    category: 'assessment',
  },
  grading: {
    link: '/grading',
    label: 'Grading',
    icon: IconChecklist,
    roles: ['ASSISTANT'],
    category: 'assessment',
  },
  'regrade-requests': {
    link: '/regrade-requests',
    label: 'Resubmits',
    icon: IconRotate,
    roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
    category: 'assessment',
  },

  // People
  students: {
    link: '/students',
    label: 'Students',
    icon: IconUsers,
    roles: ['OWNER'],
    category: 'people',
  },
  teams: {
    link: '/teams',
    label: 'Teams',
    icon: IconUsersGroup,
    roles: ['OWNER'],
    tiers: ['PRO'],
    isProTier: true,
    category: 'people',
  },
  assistants: {
    link: '/assistants',
    label: 'Assistants',
    icon: IconUserCheck,
    roles: ['OWNER'],
    isProTier: true,
    category: 'people',
  },

  // Integrations
  repositories: {
    link: '/repositories',
    label: 'Repositories',
    icon: IconBrandGithub,
    roles: ['OWNER'],
    category: 'integrations',
  },

  // Assessment (continued)
  tokens: {
    link: '/tokens',
    label: 'Tokens',
    icon: IconCoin,
    roles: ['OWNER', 'STUDENT'],
    isProTier: true,
    category: 'assessment',
  },

  // Settings
  settings: {
    link: '/settings/general',
    label: 'Class Settings',
    icon: IconSettings,
    roles: ['OWNER'],
    category: 'settings',
  },
};
