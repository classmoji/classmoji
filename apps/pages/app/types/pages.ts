/**
 * Shared type definitions for the Pages app.
 * These represent serialized loader data shapes, not raw Prisma types.
 */

export interface PageSummary {
  id: string;
  title: string;
  slug: string | null;
  is_draft: boolean;
  is_public: boolean;
  show_in_student_menu?: boolean;
  header_image_url?: string | null;
  updated_at?: string | Date;
  creator?: { login: string | null } | null;
  width?: number;
  content_path?: string;
}

export interface ClassroomSummary {
  id: string;
  name: string;
  slug: string;
  avatar_url?: string | null;
  git_organization?: {
    login: string | undefined;
    repo?: string | null;
    avatar_url?: string | null;
  } | null;
}

export interface PageForContent {
  title: string;
  content_path: string;
  classroom_id: string;
  is_draft: boolean;
  is_public: boolean;
  header_image_url?: string | null;
  header_image_position?: number | null;
  classroom: {
    id: string;
    slug: string;
    name: string;
    term: string | null;
    year: number | null;
    avatar_url?: string | null;
    git_organization?: {
      login: string;
      provider: string;
      avatar_url?: string | null;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PagesUser {
  id: string;
  login: string | null;
  name?: string | null;
  provider_email?: string | null;
  classroom_memberships?: Array<{
    role: string;
    classroom: { slug: string; name: string };
  }>;
}

export interface ClassroomListItem {
  slug: string;
  name: string;
  term: string | null;
  year: number | null;
  role: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote block objects have dynamic prop shapes per block type
export interface BlockLike {
  type: string;
  props?: Record<string, any>;
  content?: Array<{ type: string; text?: string; styles?: Record<string, unknown> }>;
  children?: BlockLike[];
}
