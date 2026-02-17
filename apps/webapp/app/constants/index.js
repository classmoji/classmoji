export const DEMO_ORG_ID = 201022016;

// Paths where "recent viewers" makes sense for students/assistants (shared content)
// Personal routes like dashboard, grades, tokens are excluded to avoid privacy confusion
export const SHARED_CONTENT_PATHS = [
  'pages/',
  'slides/',
  'modules/',
  'calendar',
];

export * from './routes';
export * from './roleSettings';
export * from './actionTypes';
