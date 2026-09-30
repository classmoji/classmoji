import type { Prisma, Role, SubscriptionTier } from '@prisma/client';
import { GIT_IDENTITY } from '@classmoji/database';

// Classroom-settings projection shared by the root loader's user queries. Single
// source of truth so adding a field is one edit, not four. Only non-sensitive
// fields the client nav/theme needs (never API keys).
export const CLASSROOM_SETTINGS_SELECT = {
  quizzes_enabled: true,
  slides_enabled: true,
  show_modules: true,
  show_pages: true,
  show_repos: true,
  theme: true,
  updated_at: true,
} as const satisfies Prisma.ClassroomSettingsSelect;

// Git-organization projection for the root loader. The client reads `login`
// (links to the org on the git host); the loader turns `provider_id` into the
// org avatar.
export const ROOT_GIT_ORGANIZATION_SELECT = {
  id: true,
  provider: true,
  provider_id: true,
  login: true,
} as const satisfies Prisma.GitOrganizationSelect;

// Membership projection for the root loader: what the client reads of a
// membership, its `id` and `role`, plus its classroom.
export const ROOT_MEMBERSHIP_SELECT = {
  id: true,
  role: true,
  classroom: {
    include: {
      git_organization: { select: ROOT_GIT_ORGANIZATION_SELECT },
      settings: { select: CLASSROOM_SETTINGS_SELECT },
    },
  },
} as const satisfies Prisma.ClassroomMembershipSelect;

// The Prisma include used by every root.tsx loader User query. One definition
// so the three lookups and the types below cannot drift apart.
export const ROOT_USER_INCLUDE = {
  classroom_memberships: { select: ROOT_MEMBERSHIP_SELECT },
  ...GIT_IDENTITY,
} as const satisfies Prisma.UserInclude;

type UserInclude = { include: typeof ROOT_USER_INCLUDE };

// User from Prisma with classroom memberships and git identity accounts included
type UserWithMembershipsAndAccounts = Prisma.UserGetPayload<UserInclude>;

// The loader flattens the identity accounts: `login` is the Github username
// (null for an account that has not connected Github yet).
export type UserWithMemberships = Omit<UserWithMembershipsAndAccounts, 'accounts'> & {
  login: string | null;
};

// The classroom shape nested inside a membership (from the include above)
export type ClassroomWithSettings =
  UserWithMemberships['classroom_memberships'][number]['classroom'];

// The settings subset selected in the include
export type ClassroomSettingsSubset = NonNullable<ClassroomWithSettings['settings']>;

// A single raw membership from the Prisma include
type RawMembership = UserWithMemberships['classroom_memberships'][number];

// The mapped membership shape produced by the root.tsx loader.
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
  /** A Github account is connected (required before joining a classroom). */
  has_github: boolean;
  /** Has an email+password sign-in. */
  has_password: boolean;
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

  // Ask Moji (course assistant) slice
  isAskMojiOpen: boolean;
  setAskMojiOpen: (open: boolean) => void;
  askMojiEnabled: boolean;
  setAskMojiEnabled: (enabled: boolean) => void;
  askMojiActive: boolean;
  setAskMojiActive: (active: boolean) => void;

  // Guided tour orchestration: a single "Take a tour" runs the landing tour,
  // then the instructor class tour, then the student class tour, in sequence.
  // Phase + step are persisted so a refresh resumes the tour where it left off.
  tourPhase: TourPhase;
  tourStep: number;
  startFullTour: () => void;
  setTourPhase: (phase: TourPhase) => void;
  setTourStep: (step: number) => void;
  endTour: () => void;
}

export type TourPhase = 'idle' | 'landing' | 'instructor' | 'student';

export { Role, SubscriptionTier };
