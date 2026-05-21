/**
 * Types used by the Classrooms Landing screen.
 */

export type LandingRole = 'OWNER' | 'ASSISTANT' | 'STUDENT' | 'PENDING INVITE';

export interface LandingClass {
  id: string;
  /** Bare classroom UUID for API calls (pin/reorder). `id` is composite `${classroomId}:${role}` for UI dedup. */
  classroomId: string;
  name: string;
  subtitle: string;
  slug: string;
  role: LandingRole;
  hue: number;
  students: number;
  pending: number;
  progress: number;
  updated: string;
  archived: boolean;
  pin_order: number | null;
  is_active: boolean;
  updated_at: string | Date;
  // Pass-through for navigation handler
  organization: {
    id: string;
    login: string;
    name?: string | null;
  };
  hasAcceptedInvite: boolean;
}
