// TEMPORARY MOCK DATA FOR TESTING - DELETE BEFORE PRODUCTION

// Emoji mappings as object for grade calculations (emoji -> numeric grade)
export const mockEmojiMappings = {
  '🔥': 100,
  '✨': 95,
  '👍': 90,
  '✅': 85,
  '👌': 80,
  '🆗': 75,
  '📝': 70,
  '⚠️': 65,
};

// Array version for UI/iteration purposes
const mockEmojiMappingsArray = [
  { id: 1, emoji: '🔥', grade: 100 },
  { id: 2, emoji: '✨', grade: 95 },
  { id: 3, emoji: '👍', grade: 90 },
  { id: 4, emoji: '✅', grade: 85 },
  { id: 5, emoji: '👌', grade: 80 },
  { id: 6, emoji: '🆗', grade: 75 },
  { id: 7, emoji: '📝', grade: 70 },
  { id: 8, emoji: '⚠️', grade: 65 },
];

export const mockSettings = {
  id: 1,
  late_penalty_points_per_hour: 0.5,
  max_late_penalty: 20,
};

export const mockLetterGradeMappings = [
  { id: 1, letter_grade: 'A', min_grade: 90 },
  { id: 2, letter_grade: 'B', min_grade: 80 },
  { id: 3, letter_grade: 'C', min_grade: 70 },
  { id: 4, letter_grade: 'D', min_grade: 60 },
  { id: 5, letter_grade: 'F', min_grade: 0 },
];

export const mockModules = [
  {
    id: 1,
    title: 'Lab 1',
    weight: 5,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 101, title: 'Setup', weight: 30, module_id: 1 },
      { id: 102, title: 'Implementation', weight: 50, module_id: 1 },
      { id: 103, title: 'Testing', weight: 20, module_id: 1 },
    ],
  },
  {
    id: 2,
    title: 'Lab 2',
    weight: 5,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 201, title: 'Part A', weight: 50, module_id: 2 },
      { id: 202, title: 'Part B', weight: 50, module_id: 2 },
    ],
  },
  {
    id: 3,
    title: 'Lab 3',
    weight: 5,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 301, title: 'Exercise', weight: 100, module_id: 3 },
    ],
  },
  {
    id: 4,
    title: 'HW 1',
    weight: 10,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 1,
    assignments: [
      { id: 401, title: 'Problem 1', weight: 25, module_id: 4 },
      { id: 402, title: 'Problem 2', weight: 25, module_id: 4 },
      { id: 403, title: 'Problem 3', weight: 25, module_id: 4 },
      { id: 404, title: 'Problem 4', weight: 25, module_id: 4 },
    ],
  },
  {
    id: 5,
    title: 'HW 2',
    weight: 10,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 501, title: 'Q1', weight: 33, module_id: 5 },
      { id: 502, title: 'Q2', weight: 33, module_id: 5 },
      { id: 503, title: 'Q3', weight: 34, module_id: 5 },
    ],
  },
  {
    id: 6,
    title: 'HW 3',
    weight: 10,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 601, title: 'Part 1', weight: 50, module_id: 6 },
      { id: 602, title: 'Part 2', weight: 50, module_id: 6 },
    ],
  },
  {
    id: 7,
    title: 'Midterm',
    weight: 15,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 701, title: 'Exam', weight: 100, module_id: 7 },
    ],
  },
  {
    id: 8,
    title: 'Project 1',
    weight: 15,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 801, title: 'Design', weight: 30, module_id: 8 },
      { id: 802, title: 'Code Quality', weight: 40, module_id: 8 },
      { id: 803, title: 'Documentation', weight: 30, module_id: 8 },
    ],
  },
  {
    id: 9,
    title: 'Project 2',
    weight: 15,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 901, title: 'Implementation', weight: 60, module_id: 9 },
      { id: 902, title: 'Testing', weight: 40, module_id: 9 },
    ],
  },
  {
    id: 10,
    title: 'Final',
    weight: 10,
    is_published: true,
    is_extra_credit: false,
    drop_lowest_count: 0,
    assignments: [
      { id: 1001, title: 'Final Exam', weight: 100, module_id: 10 },
    ],
  },
  {
    id: 11,
    title: 'Extra Credit',
    weight: 5,
    is_published: true,
    is_extra_credit: true,
    drop_lowest_count: 0,
    assignments: [{ id: 1101, title: 'Bonus Task', weight: 100, module_id: 11 }],
  },
];

// Backwards compatibility alias
export const mockAssignments = mockModules;

const firstNames = [
  'Emma',
  'Liam',
  'Olivia',
  'Noah',
  'Ava',
  'William',
  'Sophia',
  'James',
  'Isabella',
  'Oliver',
  'Charlotte',
  'Benjamin',
  'Amelia',
  'Elijah',
  'Mia',
  'Lucas',
  'Harper',
  'Mason',
  'Evelyn',
  'Logan',
  'Abigail',
  'Alexander',
  'Emily',
  'Ethan',
  'Elizabeth',
];

const lastNames = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
];

function generateRandomGrade(assignmentId, basePerformance) {
  // basePerformance is 0-1, represents student overall ability
  // Add some randomness per assignment
  const variance = (Math.random() - 0.5) * 0.3; // +/- 15%
  const performance = Math.max(0.3, Math.min(1, basePerformance + variance));

  // Map to emoji (higher index = better grade)
  const emojiIndex = Math.floor(performance * mockEmojiMappingsArray.length);
  const emoji = mockEmojiMappingsArray[Math.min(emojiIndex, mockEmojiMappingsArray.length - 1)];

  return {
    id: assignmentId * 1000 + Math.floor(Math.random() * 1000),
    grade: emoji.emoji,
  };
}

function generateStudentData(index) {
  const firstName = firstNames[index % firstNames.length];
  const lastName = lastNames[Math.floor(index / firstNames.length) % lastNames.length];
  const login = `${firstName.toLowerCase()}${lastName.toLowerCase()}${index}`;
  const email = `${login}@university.edu`;

  // Base performance varies by student (0.5 = 50th percentile to 1.0 = 100th percentile)
  const basePerformance = 0.5 + Math.random() * 0.5;

  const repositories = mockModules.map(module => {
    const assignments = module.assignments.map(assignment => {
      const grades = [generateRandomGrade(assignment.id, basePerformance)];

      // Random late penalty (30% chance of being late)
      const isLate = Math.random() < 0.3;
      const numLateHours = isLate ? Math.floor(Math.random() * 48) : 0;

      return {
        id: assignment.id * 100 + index,
        assignment_id: assignment.id,
        grades,
        num_late_hours: numLateHours,
        is_late_override: false,
        extension_hours: 0,
        assignment: {
          id: assignment.id,
          title: assignment.title,
          weight: assignment.weight,
        },
        token_transactions: [],
      };
    });

    return {
      id: module.id * 100 + index,
      module_id: module.id,
      module: {
        id: module.id,
        title: module.title,
        weight: module.weight,
        is_extra_credit: module.is_extra_credit,
        drop_lowest_count: module.drop_lowest_count,
      },
      assignments,
    };
  });

  return {
    id: index + 1,
    name: `${firstName} ${lastName}`,
    login,
    email,
    avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${login}`,
    repositories,
  };
}

export const mockStudents = Array.from({ length: 75 }, (_, i) => generateStudentData(i));

export const mockMemberships = mockStudents.map((student, index) => ({
  id: student.id,
  user_id: student.id,
  comment: index % 5 === 0 ? 'Great work this semester!' : index % 7 === 0 ? 'Needs improvement' : null,
  letter_grade: index % 10 === 0 ? 'A+' : null, // 10% of students have adjusted grade
}));
