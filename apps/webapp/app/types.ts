import type { Prisma, Role, SubscriptionTier } from '@prisma/client';

// The Prisma include shape used in root.tsx loader for User queries
type UserInclude = {
  include: {
    classroom_memberships: {
      include: {
        classroom: {
          include: {
            git_organization: true;
            settings: {
              select: {
                quizzes_enabled: true;
                slides_enabled: true;
                updated_at: true;
              };
            };
          };
        };
      };
    };
  };
};

// Base user from Prisma with classroom memberships included
export type UserWithMemberships = Prisma.UserGetPayload<UserInclude>;

// The classroom shape nested inside a membership (from the include above)
export type ClassroomWithSettings =
  UserWithMemberships['classroom_memberships'][number]['classroom'];

// The settings subset selected in the include
export type ClassroomSettingsSubset = NonNullable<ClassroomWithSettings['settings']>;

// A single raw membership from the Prisma include
type RawMembership = UserWithMemberships['classroom_memberships'][number];

// The mapped membership shape produced by root.tsx loader (lines 233-248)
// Adds an `organization` property with classroom fields + avatar_url + login alias
export interface MembershipOrganization extends ClassroomWithSettings {
  login: string;
  avatar_url: string | null;
}

export interface MembershipWithOrganization extends RawMembership {
  organization: MembershipOrganization;
}

// Subscription shape used in the UI.
// The subscription service returns a synthetic FREE record when no DB row exists.
export type AppSubscription =
  | Prisma.SubscriptionGetPayload<object>
  | {
      id: null;
      tier: SubscriptionTier;
      stripe_subscription_id?: null;
      started_at?: null;
      ends_at?: null;
      cancelled_at?: null;
      cancellation_reason?: null;
      created_at?: null;
      updated_at?: null;
      user_id?: null;
    };

// The augmented user stored in the Zustand store
// Root loader mutates user to add .subscription and .memberships
// User.image (Prisma) is used as avatar_url in the UI
export interface AppUser extends UserWithMemberships {
  subscription?: AppSubscription | null;
  memberships?: MembershipWithOrganization[];
  avatar_url?: string | null;
}

// Zustand store state — main store in store/index.ts
export interface StoreState {
  // User slice
  tokenBalance: number | null;
  role: Role | null;
  classroom: MembershipOrganization | null;
  user: AppUser | null;
  membership: MembershipWithOrganization | null;
  subscription: AppSubscription | null;
  setRole: (role: Role | null) => void;
  setMembership: (membership: MembershipWithOrganization | null) => void;
  setClassroom: (classroom: MembershipOrganization | null) => void;
  setUser: (user: AppUser | null) => void;
  setSubscription: (subscription: AppSubscription | null) => void;
  setTokenBalance: (tokenBalance: number | null) => void;

  // App slice
  showSpinner: boolean;
  setShowSpinner: (showSpinner: boolean) => void;
}

// Template assignment shape from GitHub issues API
export interface TemplateAssignment {
  title: string;
  body: string;
}

// Assignment form store state — admin.$class.modules.form/store.ts
export interface AssignmentFormState {
  assignment: AssignmentFormData;
  template: string;
  templateAssignments: TemplateAssignment[];
  assignmentsToRemove: AssignmentFormData[];
  setAssignmentValue: (key: string, value: unknown) => void;
  resetAssignment: () => void;
  setAssignment: (assignment: AssignmentFormData) => void;
  setTemplate: (template: string) => void;
  setTemplateAssignments: (templateAssignments: TemplateAssignment[]) => void;
  addAssignmentToRemove: (assignment: AssignmentFormData) => void;
  resetAssignmentsToRemove: () => void;
}

export interface AssignmentFormData {
  id: string | null;
  title: string;
  weight: number;
  description: string;
  student_deadline: string | null;
  release_at: string | null;
  grader_deadline: string | null;
  tokens_per_hour: number;
  branch: string;
  workflow_file: string;
  linkedPageIds: string[];
  linkedSlideIds: string[];
}

export { Role, SubscriptionTier };
