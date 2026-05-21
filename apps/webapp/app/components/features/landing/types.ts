/**
 * Types used by the Classrooms Landing screen.
 */

export type LandingRole = 'OWNER' | 'ASSISTANT' | 'STUDENT' | 'PENDING INVITE';

export interface LandingClass {
  id: string;
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
  // Pass-through for navigation handler
  organization: {
    id: string;
    login: string;
    name?: string | null;
  };
  hasAcceptedInvite: boolean;
}
