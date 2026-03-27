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
  term: string | null;
  year: number | null;
  git_organization?: {
    login: string;
    avatar_url: string | null;
  } | null;
  modules?: ClassroomModule[];
}

export interface ModuleConfig {
  includeQuizzes: boolean;
}

export interface CreateClassroomFormValues {
  git_org_id: string;
  name: string;
  term: string;
  year: number;
}
