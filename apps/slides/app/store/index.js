import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * Zustand store for slides app state
 * Using Zustand instead of React Context prevents HMR issues
 * where context identity changes break the provider/consumer link
 */
const useStore = create(
  devtools(set => ({
    // User state
    user: null,
    setUser: user =>
      set(state => {
        if (state.user?.id === user?.id) return state;
        return { user };
      }),
  }))
);

export default useStore;
