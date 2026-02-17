import Papa from 'papaparse';
import _ from 'lodash';

import { roundToTwo } from '~/utils/helpers';

export const exportToCsv = (students, assignments, filename) => {
  const headersRows = getHeaders(assignments);
  const studentsRows = getStudentRows(students, assignments);

  const csv = Papa.unparse([...headersRows, ...studentsRows]);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadFile(`${filename}.csv`, blob);
};

const getStudentRows = (students, assignments) => {
  const rows = students.map(student => {
    const studentRow = [
      student.user.student_id,
      student.user.name || student.user.login,
      student.user.login,
      roundToTwo(parseFloat(student.numeric_grade)),
      student.letter_grade,
    ];

    assignments.forEach(assignment => {
      const repositoryAssignments = _.sortBy(assignment.repositoryAssignments || assignment.issues, 'title');
      const repos = student.repos;
      const repo = Object.values(repos).find(repo => repo.name.includes(assignment.title));

      if (!repo) {
        (assignment.repositoryAssignments || assignment.issues).forEach(() => studentRow.push('X'));
        return;
      } else {
        repositoryAssignments.forEach(repoAssignment => {
          const repoAssignmentGrade = (repo.repositoryAssignments || repo.issues).find(
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

const getHeaders = assignments => {
  let headerOne = [null, null, null, null, null];
  let headerTwo = ['ID', 'Student', 'Login', 'Grade', 'Letter Grade'];

  assignments.forEach(assignment => {
    const repositoryAssignments = _.sortBy(assignment.repositoryAssignments || assignment.issues, 'title');
    let rowOne = [assignment.title];
    let rowTwo = [];

    while (rowOne.length < repositoryAssignments.length) rowOne.push(null);

    repositoryAssignments.forEach(repoAssignment => {
      headerTwo.push(repoAssignment.title);
    });

    headerOne = [...headerOne, ...rowOne];
    headerTwo = [...headerTwo, ...rowTwo];
  });

  return [headerOne, headerTwo];
};

const downloadFile = (fileName, data) => {
  const downloadLink = document.createElement('a');
  downloadLink.download = fileName;
  const url = URL.createObjectURL(data);
  downloadLink.href = url;
  downloadLink.click();
  URL.revokeObjectURL(url);
};
