import type { EmojiGrade } from '@classmoji/ui-components';

export type AssignmentKind = 'QUIZ' | 'ASGN' | 'PROJ';

export interface AssignmentHeaderData {
  kind: AssignmentKind;
  /** Module label (no prefix). Empty string or undefined hides the chip. */
  module?: string;
  /** Weight note e.g. "· 15% of grade". Empty string or undefined hides. */
  weightNote?: string;
  /** Formatted due date e.g. "Apr 8, 11:59 PM". Empty string hides. */
  due?: string;
  /** Relative due note e.g. "in 3d". Empty string hides. */
  dueRelative?: string;
  title: string;
  /** Description — backtick-wrapped segments render as inline `code`. */
  description?: string;
  /** GitHub repo URL (full href). When present renders "Open repository" button. */
  githubUrl?: string | null;
  /** Short repo path e.g. "cs101/alex-stein/hw2" for the mono button. */
  repoUrl?: string | null;
  /** When truthy, renders the "Request extension" button. */
  extensionCost?: number | null;
}

export interface IssueRowData {
  /** Short identifier shown as "#id" (e.g., question number). */
  id: string | number;
  label: string;
  status: 'open' | 'closed';
}

export interface ChecklistData {
  items: IssueRowData[];
  /** Keyed by issue id. Only relevant in admin/grader mode. */
  grades?: Record<string, EmojiGrade>;
  /** Full set of emoji choices to show in the scale. */
  emojiGrades?: EmojiGrade[];
  onPick?: (issueId: string | number, grade: EmojiGrade) => void;
  onRelease?: () => void;
  onSaveDraft?: () => void;
}

export interface TeamMemberData {
  initials: string;
  /** OKLCH hue number for the gradient avatar. */
  hue: number;
  name: string;
  linesChanged: number;
}

export interface TeamData {
  members: TeamMemberData[];
}

export interface ActivityCommit {
  sha: string;
  msg: string;
  time: string;
}

export interface ActivityData {
  commits: ActivityCommit[];
}

export type ViewRole = 'admin' | 'student';

/** Default emoji grade scale used when no classroom mapping provided. */
export const DEFAULT_EMOJI_GRADES: EmojiGrade[] = [
  { emoji: '🌟', pct: 100, label: 'Perfect' },
  { emoji: '✅', pct: 90, label: 'Great' },
  { emoji: '👍', pct: 80, label: 'Good' },
  { emoji: '🤔', pct: 70, label: 'Okay' },
  { emoji: '⚠️', pct: 50, label: 'Weak' },
  { emoji: '💀', pct: 0, label: 'Failed' },
];
