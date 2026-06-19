/**
 * Types used by the Classrooms Landing screen.
 */

export type LandingRole = 'OWNER' | 'ASSISTANT' | 'STUDENT' | 'PENDING INVITE';

export interface LandingClass {
  id: string;
  /** Bare classroom UUID for API calls (pin/reorder, archive). `id` is composite `${classroomId}:${role}` for UI dedup. */
  classroomId: string;
  /** Underlying DB role on the membership (OWNER/ASSISTANT/STUDENT/TEACHER) used to disambiguate pin/archive calls for users with multiple memberships per classroom. */
  membershipRole: string;
  name: string;
  subtitle: string;
  slug: string;
  /** GitHub organization login (shown under the class name). */
  githubOrg: string;
  role: LandingRole;
  hue: number;
  /** Organization avatar URL (GitHub org image); falls back to the ClassMark when absent. */
  avatar: string | null;
  updated: string;
  archived: boolean;
  pin_order: number | null;
  status: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED';
  is_archived: boolean;
  /** True for the auto-provisioned "Example Course" sandbox (onboarding hand-off target). */
  is_example: boolean;
  updated_at: string | Date;
  // Pass-through for navigation handler
  organization: {
    id: string;
    login: string;
    name?: string | null;
  };
  hasAcceptedInvite: boolean;
}
