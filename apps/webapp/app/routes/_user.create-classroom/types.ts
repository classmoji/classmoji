export interface GitOrganizationOption {
  id: string;
  login: string;
  avatar_url: string | null;
  classrooms: Array<{
    id: string;
    slug: string;
    name: string;
  }>;
}

export interface ClassroomModule {
  id: string;
  title: string;
  template?: string | null;
  type: string;
  weight?: number;
  is_extra_credit?: boolean;
  _count?: {
    assignments?: number;
    quizzes?: number;
  };
}

export interface OwnedClassroom {
  id: string;
  slug?: string;
  name: string;
  git_organization?: {
    login: string;
    avatar_url?: string | null;
    [key: string]: unknown;
  } | null;
  repositories?: ClassroomModule[];
  _count?: {
    pages: number;
    slides: number;
    modules: number;
    calendar_events: number;
    emoji_mappings: number;
    letter_grade_mappings: number;
  };
}

/**
 * The "Also copy" toggles on the import step. Settings groups mirror the
 * server's ConfigImportSelections; pages/slides/modules are the content
 * copiers. apiKeys (secrets) and calendar (verbatim dates) are opt-in.
 */
export interface ImportSelections {
  grading: boolean;
  gradeScales: boolean;
  tokens: boolean;
  features: boolean;
  aiConfig: boolean;
  apiKeys: boolean;
  calendar: boolean;
  pages: boolean;
  slides: boolean;
  modules: boolean;
  /** Copy each imported repo's template into this org as a private repo. */
  duplicateTemplates: boolean;
}

export interface ModuleConfig {
  includeQuizzes: boolean;
}

export interface CreateClassroomFormValues {
  git_org_id: string;
  name: string;
  slug: string;
  /** Manual content-repo override; '' = default to `content-{namespace}`. */
  content_repo: string;
}
