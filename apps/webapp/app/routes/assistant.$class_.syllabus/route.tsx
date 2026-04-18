// Re-export the student syllabus stub — assistants see the same read-only view.
// Per CLAUDE.md: "assistant routes should re-export from student routes".
export { loader, default } from '../student.$class.syllabus/route';
