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
  IconClipboardList,
  IconHeartRateMonitor,
  IconStack2,
  IconLifebuoy,
} from '@tabler/icons-react';

/**
 * Route categories for organized navigation
 */
export const routeCategories = {
  content: {
    label: 'Content',
    // Pages is LAST on purpose: it is the class's reading surface (its front
    // page, docked), not a task list, so it sits after the coursework entries.
    items: ['modules', 'repositories', 'assignments', 'slides', 'quizzes', 'pages'],
  },
  assessment: {
    label: 'Assessment',
    items: ['grades', 'grading', 'regrade-requests', 'tokens'],
  },
  people: {
    label: 'People',
    items: ['students', 'teams', 'staff'],
  },
  integrations: {
    label: 'Integrations',
    items: ['gitrepos', 'repo-health'],
  },
  settings: {
    label: 'Settings',
    items: ['settings', 'memberSettings', 'support'],
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
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
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
    icon: IconStack2,
    // OWNER always sees Modules to build them; every other role only when
    // the instructor enables it (gated by show_modules in CommonLayout).
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    category: 'content',
  },
  repositories: {
    link: '/repos',
    label: 'Repositories',
    icon: IconFileText,
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    category: 'content',
  },
  assignments: {
    link: '/assignments',
    label: 'Assignments',
    icon: IconClipboardList,
    roles: ['STUDENT'],
    category: 'content',
  },
  slides: {
    link: '/slides',
    label: 'Slides',
    icon: IconPresentation,
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    category: 'content',
  },
  pages: {
    link: '/pages',
    label: 'Pages',
    icon: IconBook,
    // One entry for everyone, but it lands somewhere different per role: staff
    // get the page CMS list, students/assistants get the class front page
    // docked (the Option C reader). The sidebar no longer hangs one entry per
    // page — CommonLayout hides this whole entry from non-owners when the
    // class has no readable pages, the same way Modules hides.
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
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
    roles: ['OWNER', 'TEACHER', 'STUDENT', 'ASSISTANT'],
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
    // The queue lists what the viewer is assigned to grade, and any staff role
    // can be flagged as a grader — not assistants alone.
    roles: ['TEACHER', 'ASSISTANT'],
    category: 'assessment',
  },
  'regrade-requests': {
    link: '/regrade-requests',
    label: 'Resubmits',
    icon: IconRotate,
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    category: 'assessment',
  },

  // People
  students: {
    link: '/students',
    label: 'Students',
    icon: IconUsers,
    // Reading the roster is a teaching-team right, so the whole team gets the
    // entry; for non-owners it resolves to their own prefix, which re-exports
    // the admin loader and its OWNER-only field split.
    roles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    category: 'people',
  },
  teams: {
    link: '/teams',
    label: 'Teams',
    icon: IconUsersGroup,
    roles: ['OWNER'],
    category: 'people',
  },
  staff: {
    link: '/staff',
    label: 'Teaching Staff',
    icon: IconUserCheck,
    // Seeing who is on the team is a teaching-team right, so the whole team
    // gets the entry; for non-owners it resolves to their own prefix, which
    // re-exports the admin loader (read only — no action lives there).
    roles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    category: 'people',
  },

  // Integrations
  gitrepos: {
    link: '/gitrepos',
    label: 'GitHub Repos',
    icon: IconBrandGithub,
    roles: ['OWNER'],
    category: 'integrations',
  },
  'repo-health': {
    link: '/repo-health',
    label: 'Repo Health',
    icon: IconHeartRateMonitor,
    roles: ['OWNER'],
    category: 'integrations',
  },

  // Assessment (continued)
  tokens: {
    link: '/tokens',
    label: 'Tokens',
    icon: IconCoin,
    roles: ['OWNER', 'STUDENT'],
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
  memberSettings: {
    link: '/settings',
    label: 'Settings',
    icon: IconSettings,
    // Personal member settings, not the owner-only classroom settings above.
    roles: ['STUDENT', 'TEACHER', 'ASSISTANT'],
    category: 'settings',
  },
  support: {
    link: '/support',
    label: 'Help & Feedback',
    icon: IconLifebuoy,
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    category: 'settings',
  },
};
