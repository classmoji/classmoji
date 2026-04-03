import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** Classroom membership shape as loaded by the root loader */
interface SlideUserMembership {
  role: string;
  classroom?: {
    id: string;
    slug: string;
    name: string;
    term?: string | null;
    year?: number | null;
    git_organization?: {
      login: string;
      github_installation_id?: string | null;
      settings?: Record<string, unknown> | null;
    } | null;
  } | null;
}

/** User shape as loaded by the root loader (Prisma user + classroom memberships) */
export interface SlideUser {
  id: string;
  login: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  classroom_memberships?: SlideUserMembership[];
}

interface StoreState {
  user: SlideUser | null;
  setUser: (user: SlideUser | null) => void;
}

/**
 * Zustand store for slides app state
 * Using Zustand instead of React Context prevents HMR issues
 * where context identity changes break the provider/consumer link
 */
const useStore = create<StoreState>()(
  devtools(set => ({
    // User state
    user: null,
    setUser: (user: SlideUser | null) =>
      set(state => {
        if (state.user?.id === user?.id) return state;
        return { user };
      }),
  }))
);

export default useStore;
