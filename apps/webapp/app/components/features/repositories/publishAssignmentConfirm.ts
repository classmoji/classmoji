import dayjs from 'dayjs';

export interface PublishAssignmentConfirmInput {
  /** Its repositories still have to be created (a REPO assignment only). */
  needsRepo: boolean;
  /** Already open to students: only the repositories are outstanding. */
  assignmentPublished: boolean;
  /** What the assignment is; only a REPO one has a repository to speak of. */
  kind?: string;
  /** Opens (`release_at`): a date still ahead is when students get it. */
  opensAt?: string | Date | null;
}

/**
 * The confirm a module card's Publish (or Create repos) asks before it acts,
 * worded for what the row is: a repository assignment speaks of its
 * repositories; a quiz or form of itself, and of its Opens date when that is
 * still ahead.
 */
export const publishAssignmentConfirm = (
  opts: PublishAssignmentConfirmInput,
  now: Date = new Date()
): { title: string; content: string; okText: string } => {
  // Already open to students, but nobody has repositories yet.
  if (opts.assignmentPublished) {
    return {
      title: 'Create student repositories',
      content:
        'This assignment is already open to students, but its repositories have not been created. This creates them.',
      okText: 'Create',
    };
  }
  const kind = opts.kind ?? 'REPO';
  if (kind === 'REPO') {
    return {
      title: 'Publish assignment',
      content: opts.needsRepo
        ? 'This creates the student repositories first, then opens the assignment to students.'
        : 'This opens the assignment to students. Its repository is already published.',
      okText: 'Publish',
    };
  }
  const noun = kind === 'QUIZ' ? 'quiz' : 'form';
  const opensLater = opts.opensAt != null && dayjs(opts.opensAt).isAfter(now);
  return {
    title: kind === 'QUIZ' ? 'Publish quiz' : 'Publish assignment',
    content: opensLater
      ? `Students get this ${noun} on ${dayjs(opts.opensAt).format('ddd MMM D · h:mm A')}.`
      : `This opens the ${noun} to students.`,
    okText: 'Publish',
  };
};
