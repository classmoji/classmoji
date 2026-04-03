import Papa from 'papaparse';
import _ from 'lodash';

import { roundToTwo } from '~/utils/helpers';

interface GradeStudent {
  user: { school_id: string; name: string; login: string };
  numeric_grade: string;
  letter_grade: string;
  repos: Record<
    string,
    {
      name: string;
      repositoryAssignments?: Array<{ title: string; grade?: string }>;
      issues?: Array<{ title: string; grade?: string }>;
    }
  >;
}

interface GradeAssignment {
  title: string;
  repositoryAssignments?: Array<{ title: string }>;
  issues?: Array<{ title: string }>;
}

export const exportToCsv = (
  students: GradeStudent[],
  assignments: GradeAssignment[],
  filename: string
) => {
  const headersRows = getHeaders(assignments);
  const studentsRows = getStudentRows(students, assignments);

  const csv = Papa.unparse([...headersRows, ...studentsRows]);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadFile(`${filename}.csv`, blob);
};

const getStudentRows = (students: GradeStudent[], assignments: GradeAssignment[]) => {
  const rows = students.map((student: GradeStudent) => {
    const studentRow = [
      student.user.school_id,
      student.user.name || student.user.login,
      student.user.login,
      roundToTwo(parseFloat(student.numeric_grade)),
      student.letter_grade,
    ];

    assignments.forEach((assignment: GradeAssignment) => {
      const repositoryAssignments = _.sortBy(
        assignment.repositoryAssignments || assignment.issues,
        'title'
      );
      const repos = student.repos;
      const repo = Object.values(repos).find(r => r.name.includes(assignment.title));

      if (!repo) {
        (assignment.repositoryAssignments || assignment.issues)?.forEach(() =>
          studentRow.push('X')
        );
        return;
      } else {
        repositoryAssignments.forEach(repoAssignment => {
          const repoAssignmentGrade = (repo.repositoryAssignments || repo.issues)?.find(
            ra => ra.title === repoAssignment.title
          );

          studentRow.push(repoAssignmentGrade?.grade || 'X');
        });
      }
    });
    return studentRow;
  });

  return rows;
};

const getHeaders = (assignments: GradeAssignment[]): (string | null)[][] => {
  let headerOne: (string | null)[] = [null, null, null, null, null];
  let headerTwo: (string | null)[] = ['ID', 'Student', 'Login', 'Grade', 'Letter Grade'];

  assignments.forEach((assignment: GradeAssignment) => {
    const repositoryAssignments = _.sortBy(
      assignment.repositoryAssignments || assignment.issues,
      'title'
    );
    const rowOne: (string | null)[] = [assignment.title];
    const rowTwo: (string | null)[] = [];

    while (rowOne.length < repositoryAssignments.length) rowOne.push(null);

    repositoryAssignments.forEach(repoAssignment => {
      headerTwo.push(repoAssignment.title);
    });

    headerOne = [...headerOne, ...rowOne];
    headerTwo = [...headerTwo, ...rowTwo];
  });

  return [headerOne, headerTwo];
};

const downloadFile = (fileName: string, data: Blob) => {
  const downloadLink = document.createElement('a');
  downloadLink.download = fileName;
  const url = URL.createObjectURL(data);
  downloadLink.href = url;
  downloadLink.click();
  URL.revokeObjectURL(url);
};
