import { calculateStudentFinalGrade, calculateLetterGrade } from '@classmoji/utils';
import type { Repository, OrganizationSettings, LetterGradeMappingEntry } from '@classmoji/utils';
import { GradeBadge, InfoTooltip, EditableCell } from '~/components';
import type { ReactNode } from 'react';

type EmojiMappings = Record<string, number>;

interface StudentRecord {
  id: string | number;
  repositories: Repository[];
}

interface Membership {
  user_id: string | number;
  comment?: string | null;
  letter_grade?: string | null;
}

interface GradeColumnConfig {
  title: string;
  tooltip?: string;
  width?: number | null;
  calculateGrade: (student: StudentRecord) => number;
  renderGrade?: (grade: number) => ReactNode;
  sorter?: ((a: StudentRecord, b: StudentRecord) => number) | null;
}

/**
 * Creates a standard grade column with consistent structure
 */
const createGradeColumn = ({
  title,
  tooltip,
  width = null,
  calculateGrade,
  renderGrade = (grade: number) => <GradeBadge grade={grade} />,
  sorter = null,
}: GradeColumnConfig) => ({
  title: tooltip ? <InfoTooltip tooltip={tooltip}>{title}</InfoTooltip> : title,
  ellipsis: true,
  ...(width && { width }),
  ...(sorter && { sorter }),
  render: (student: StudentRecord) => {
    const grade = calculateGrade(student);
    if (grade < 0) return null;
    return renderGrade(grade);
  },
});

/**
 * Creates all student grade columns
 */
export const createStudentGradeColumns = (
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings,
  letterGradeMappings: LetterGradeMappingEntry[],
  memberships: Membership[],
  handleUpdateLetterGrade: (record: Membership, dataIndex: string, value: string) => void,
  showComments: boolean
) => {
  return [
    // Comment Column
    {
      title: 'Comment',
      hidden: !showComments,
      ellipsis: true,
      width: 200,
      render: (student: StudentRecord) => {
        const membership = memberships.find((m: Membership) => m.user_id === student.id);
        return (
          <div className="max-w-xs truncate text-gray-700">
            {membership?.comment || <span className="italic text-gray-400">No comment</span>}
          </div>
        );
      },
    },

    // Adjusted Grade Column
    {
      title: (
        <InfoTooltip tooltip="Use this to override the final letter grade calculation">
          Adjusted Grade
        </InfoTooltip>
      ),
      ellipsis: true,
      width: 140,
      render: (student: StudentRecord) => {
        const membership = memberships.find((m: Membership) => m.user_id === student.id);
        return (
          <EditableCell
            record={membership}
            dataIndex="letter_grade"
            format="text"
            onUpdate={handleUpdateLetterGrade}
            placeholder="Add grade"
          />
        );
      },
    },

    // Final Letter Grade
    createGradeColumn({
      title: 'Final Letter Grade',
      tooltip: 'Final grade takes into account late penalties.',
      width: 160,
      calculateGrade: (student: StudentRecord) =>
        calculateStudentFinalGrade(student.repositories, emojiMappings, settings),
      renderGrade: (grade: number) => {
        const letterGrade = calculateLetterGrade(grade, letterGradeMappings);
        return <span className="font-semibold text-lg">{letterGrade}</span>;
      },
      sorter: (a: StudentRecord, b: StudentRecord) => {
        const gradeA = calculateStudentFinalGrade(a.repositories, emojiMappings, settings);
        const gradeB = calculateStudentFinalGrade(b.repositories, emojiMappings, settings);
        return gradeA - gradeB;
      },
    }),

    // Raw Letter Grade
    createGradeColumn({
      title: 'Raw Letter Grade',
      tooltip: 'Raw grade does not take into account late penalties.',
      width: 150,
      calculateGrade: (student: StudentRecord) =>
        calculateStudentFinalGrade(student.repositories, emojiMappings, settings, false),
      renderGrade: (grade: number) => {
        const letterGrade = calculateLetterGrade(grade, letterGradeMappings);
        return <span className="font-medium">{letterGrade}</span>;
      },
      sorter: (a: StudentRecord, b: StudentRecord) => {
        const gradeA = calculateStudentFinalGrade(a.repositories, emojiMappings, settings, false);
        const gradeB = calculateStudentFinalGrade(b.repositories, emojiMappings, settings, false);
        return gradeA - gradeB;
      },
    }),

    // Final Grade (Individual)
    createGradeColumn({
      title: 'Final Grade (Individual)',
      tooltip: 'This does not take into account group assignments, only individual assignments.',
      width: 210,
      calculateGrade: (student: StudentRecord) =>
        calculateStudentFinalGrade(student.repositories, emojiMappings, settings, true, false),
      sorter: (a: StudentRecord, b: StudentRecord) => {
        const gradeA = calculateStudentFinalGrade(
          a.repositories,
          emojiMappings,
          settings,
          true,
          false
        );
        const gradeB = calculateStudentFinalGrade(
          b.repositories,
          emojiMappings,
          settings,
          true,
          false
        );
        return gradeA - gradeB;
      },
    }),

    // Final Grade
    createGradeColumn({
      title: 'Final Grade',
      tooltip: 'This takes into account both individual and group assignments.',
      width: 210,
      calculateGrade: (student: StudentRecord) =>
        calculateStudentFinalGrade(student.repositories, emojiMappings, settings),
      sorter: (a: StudentRecord, b: StudentRecord) => {
        const gradeA = calculateStudentFinalGrade(a.repositories, emojiMappings, settings);
        const gradeB = calculateStudentFinalGrade(b.repositories, emojiMappings, settings);
        return gradeA - gradeB;
      },
    }),

    // Raw Grade
    createGradeColumn({
      title: 'Raw Grade',
      tooltip: 'This does not take into account late penalties.',
      width: 150,
      calculateGrade: (student: StudentRecord) =>
        calculateStudentFinalGrade(student.repositories, emojiMappings, settings, false),
      sorter: (a: StudentRecord, b: StudentRecord) => {
        const gradeA = calculateStudentFinalGrade(a.repositories, emojiMappings, settings, false);
        const gradeB = calculateStudentFinalGrade(b.repositories, emojiMappings, settings, false);
        return gradeA - gradeB;
      },
    }),
  ];
};
