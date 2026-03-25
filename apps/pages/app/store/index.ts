import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface StoreState {
  user: any;
  setUser: (user: any) => void;
}

/**
 * Zustand store for pages app state
 * Using Zustand instead of React Context prevents HMR issues
 * where context identity changes break the provider/consumer link
 */
const useStore = create<StoreState>()(
  devtools((set) => ({
    // User state
    user: null,
    setUser: (user: any) =>
      set((state: StoreState) => {
        if (state.user?.id === user?.id) return state;
        return { user };
      }),
  }))
);

export default useStore;
