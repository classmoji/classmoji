export type NavId =
  | 'dashboard'
  | 'calendar'
  | 'modules'
  | 'repositories'
  | 'quizzes'
  | 'grades'
  | 'resubmits'
  | 'tokens'
  | 'students'
  | 'staff';

export type NavGroup = {
  label: string;
  staffOnly?: boolean;
  items: { id: NavId; label: string }[];
};

export type ShellRole = 'staff' | 'student';

export type ShellUser = {
  name: string;
  handle: string;
  initials: string;
};
