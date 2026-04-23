import { create } from 'zustand';
import type { AssignmentFormState, AssignmentFormData, TemplateAssignment } from '~/types';

const defaultAssignment: AssignmentFormData = {
  id: null,
  title: '',
  weight: 100,
  description: '',
  student_deadline: null,
  release_at: null,
  grader_deadline: null,
  tokens_per_hour: 0,
  branch: '',
  workflow_file: '',
  linkedPageIds: [],
  linkedSlideIds: [],
};

export const useAssignmentStore = create<AssignmentFormState>(set => ({
  assignment: defaultAssignment,
  template: '',
  templateAssignments: [],
  assignmentsToRemove: [],

  setAssignmentValue: (key: string, value: unknown) =>
    set(state => ({ assignment: { ...state.assignment, [key]: value } })),
  resetAssignment: () => set({ assignment: defaultAssignment }),
  setAssignment: (assignment: AssignmentFormData) => set({ assignment }),
  setTemplate: (template: string) => set({ template }),
  setTemplateAssignments: (templateAssignments: TemplateAssignment[]) =>
    set({ templateAssignments }),
  addAssignmentToRemove: (assignment: AssignmentFormData) =>
    set(state => ({ assignmentsToRemove: [...state.assignmentsToRemove, assignment] })),
  resetAssignmentsToRemove: () => set({ assignmentsToRemove: [] }),
}));
