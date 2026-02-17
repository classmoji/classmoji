import { create } from 'zustand';

const defaultAssignment = {
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

export const useAssignmentStore = create(set => ({
  assignment: defaultAssignment,
  template: '',
  templateAssignments: [],
  assignmentsToRemove: [],

  setAssignmentValue: (key, value) => set(state => ({ assignment: { ...state.assignment, [key]: value } })),
  resetAssignment: () => set({ assignment: defaultAssignment }),
  setAssignment: assignment => set({ assignment }),
  setTemplate: template => set({ template }),
  setTemplateAssignments: templateAssignments => set({ templateAssignments }),
  addAssignmentToRemove: assignment => set(state => ({ assignmentsToRemove: [...state.assignmentsToRemove, assignment] })),
  resetAssignmentsToRemove: () => set({ assignmentsToRemove: [] }),
}));
