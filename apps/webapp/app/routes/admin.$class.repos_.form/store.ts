import { create } from 'zustand';

/** The template the repository form currently has selected (shared with the picker). */
interface RepositoryFormState {
  template: string;
  setTemplate: (template: string) => void;
}

export const useRepositoryFormStore = create<RepositoryFormState>(set => ({
  template: '',
  setTemplate: (template: string) => set({ template }),
}));
