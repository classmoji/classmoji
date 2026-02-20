import { PrismaClient } from '@prisma/client';
import { DEFAULT_EMOJI_MAPPINGS, DEFAULT_LETTER_GRADE_MAPPINGS } from '@classmoji/utils';

const prisma = new PrismaClient();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Generate fake GitHub IDs for provider_id fields (fake students/repos)
const generateFakeGitHubId = () => String(Math.floor(Math.random() * 900000000) + 100000000);

// Date helpers
const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = now.getMonth();

const dateInCurrentMonth = (day, hour = 4, minute = 59) => {
  return new Date(currentYear, currentMonth, day, hour, minute, 59);
};

const daysFromNow = (days, hour = 4, minute = 59) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 59, 0);
  return date;
};

// ============================================================================
// REAL GITHUB TEST USER IDS
// ============================================================================

const PROF_GITHUB_ID = '220514774';
const INSTRUCTOR_GITHUB_ID = '250603531';
const TA_GITHUB_ID = '250561690';
const STUDENT_GITHUB_ID = '250562559';
const CLASSMOJI_DEV_ORG_ID = '220515529';

// ============================================================================
// FAKE USERS DATA
// ============================================================================

const FAKE_TAS = [
  { login: 'alex-ta', name: 'Alex Thompson', email: 'alex.ta@example.com' },
  { login: 'jamie-ta', name: 'Jamie Rodriguez', email: 'jamie.ta@example.com' },
  { login: 'sam-ta', name: 'Sam Chen', email: 'sam.ta@example.com' },
];

const FAKE_STUDENTS = [
  { login: 'emma-student', name: 'Emma Wilson', email: 'emma@example.com' },
  { login: 'liam-student', name: 'Liam Johnson', email: 'liam@example.com' },
  { login: 'olivia-student', name: 'Olivia Brown', email: 'olivia@example.com' },
  { login: 'noah-student', name: 'Noah Davis', email: 'noah@example.com' },
  { login: 'ava-student', name: 'Ava Martinez', email: 'ava@example.com' },
];

// ============================================================================
// MODULE & ASSIGNMENT DATA (3 modules, 6 assignments)
// ============================================================================

const MODULES = [
  {
    title: 'hello-world',
    template: 'dartmouth-cs52/hello-world-template',
    weight: 5,
    type: 'INDIVIDUAL',
    is_published: true,
  },
  {
    title: 'lab1-landing-page',
    template: 'dartmouth-cs52/lab1-landingpage-template',
    weight: 8,
    type: 'INDIVIDUAL',
    is_published: true,
  },
  {
    title: 'starterpack',
    template: 'dartmouth-cs52/starterpack-template',
    weight: 5,
    type: 'INDIVIDUAL',
    is_published: false, // Draft module for testing status badge visibility
  },
];

// Assignment definitions with module reference
const getAssignments = () => [
  // hello-world (from current DB - preserve existing values)
  {
    module: 'hello-world',
    title: 'Hello World Part 1',
    weight: 50,
    is_published: true,
    student_deadline: new Date('2026-01-01T05:00:00.000Z'),
    tokens_per_hour: 2,
  },
  {
    module: 'hello-world',
    title: 'Hello World Part 2',
    weight: 50,
    is_published: false,
    student_deadline: null,
    tokens_per_hour: 2,
  },
  // lab1-landing-page
  {
    module: 'lab1-landing-page',
    title: 'Landing Page Part 1',
    weight: 50,
    is_published: true,
    student_deadline: daysFromNow(7),
    tokens_per_hour: 2,
  },
  {
    module: 'lab1-landing-page',
    title: 'Landing Page Part 2',
    weight: 50,
    is_published: false,
    student_deadline: daysFromNow(14),
    tokens_per_hour: 2,
  },
  // starterpack
  {
    module: 'starterpack',
    title: 'Vite StarterPack',
    weight: 50,
    is_published: true,
    student_deadline: daysFromNow(5),
    tokens_per_hour: 2,
  },
  {
    module: 'starterpack',
    title: 'React Router',
    weight: 50,
    is_published: false,
    student_deadline: daysFromNow(10),
    tokens_per_hour: 2,
  },
];

// ============================================================================
// MAIN SEED FUNCTION
// ============================================================================

async function main() {
  console.log('🌱 Starting comprehensive seed...\n');

  // ============================================================================
  // 1. CREATE REAL GITHUB USERS
  // ============================================================================
  console.log('👤 Creating users...');

  const professor = await prisma.user.upsert({
    where: { login: 'prof-classmoji' },
    update: {},
    create: {
      provider: 'GITHUB',
      provider_id: PROF_GITHUB_ID,
      login: 'prof-classmoji',
      name: 'Professor Classmoji',
      email: 'prof.classmoji@classmoji.io',
      provider_email: 'prof.classmoji@classmoji.io',
    },
  });

  const instructor = await prisma.user.upsert({
    where: { login: 'instructor-classmoji' },
    update: {},
    create: {
      provider: 'GITHUB',
      provider_id: INSTRUCTOR_GITHUB_ID,
      login: 'instructor-classmoji',
      name: 'Instructor Tester',
      email: 'instructor.classmoji@classmoji.io',
      provider_email: 'instructor.classmoji@classmoji.io',
    },
  });

  const ta = await prisma.user.upsert({
    where: { login: 'ta-classmoji' },
    update: {},
    create: {
      provider: 'GITHUB',
      provider_id: TA_GITHUB_ID,
      login: 'ta-classmoji',
      name: 'Teaching Assistant Tester',
      email: 'ta.classmoji@classmoji.io',
      provider_email: 'ta.classmoji@classmoji.io',
    },
  });

  const student = await prisma.user.upsert({
    where: { login: 'student-classmoji' },
    update: {},
    create: {
      provider: 'GITHUB',
      provider_id: STUDENT_GITHUB_ID,
      login: 'student-classmoji',
      name: 'Student Tester',
      email: 'student.classmoji@classmoji.io',
      provider_email: 'student.classmoji@classmoji.io',
    },
  });

  // ============================================================================
  // 2. CREATE FAKE TAs
  // ============================================================================
  console.log('👥 Creating fake TAs...');

  const fakeTAs = [];
  for (const taData of FAKE_TAS) {
    const fakeTA = await prisma.user.upsert({
      where: { login: taData.login },
      update: {},
      create: {
        provider: 'GITHUB',
        provider_id: generateFakeGitHubId(),
        login: taData.login,
        name: taData.name,
        email: taData.email,
      },
    });
    fakeTAs.push(fakeTA);
  }

  // ============================================================================
  // 3. CREATE FAKE STUDENTS
  // ============================================================================
  console.log('👥 Creating fake students...');

  const fakeStudents = [];
  for (const studentData of FAKE_STUDENTS) {
    const fakeStudent = await prisma.user.upsert({
      where: { login: studentData.login },
      update: {},
      create: {
        provider: 'GITHUB',
        provider_id: generateFakeGitHubId(),
        login: studentData.login,
        name: studentData.name,
        email: studentData.email,
      },
    });
    fakeStudents.push(fakeStudent);
  }

  // All students including the real one
  const allStudents = [student, ...fakeStudents];

  // ============================================================================
  // 4. CREATE ACCOUNTS FOR BETTERAUTH (real users only)
  // ============================================================================
  console.log('🔐 Creating BetterAuth accounts...');

  const accountData = [
    { user_id: professor.id, account_id: PROF_GITHUB_ID },
    { user_id: instructor.id, account_id: INSTRUCTOR_GITHUB_ID },
    { user_id: ta.id, account_id: TA_GITHUB_ID },
    { user_id: student.id, account_id: STUDENT_GITHUB_ID },
  ];

  for (const account of accountData) {
    await prisma.account.upsert({
      where: {
        provider_id_account_id: {
          provider_id: 'github',
          account_id: account.account_id,
        },
      },
      update: { user_id: account.user_id },
      create: {
        user_id: account.user_id,
        provider_id: 'github',
        account_id: account.account_id,
      },
    });
  }

  // ============================================================================
  // 5. CREATE SUBSCRIPTION FOR PROFESSOR
  // ============================================================================
  const existingSubscription = await prisma.subscription.findFirst({
    where: { user_id: professor.id },
  });

  if (existingSubscription) {
    await prisma.subscription.update({
      where: { id: existingSubscription.id },
      data: { tier: 'PRO' },
    });
  } else {
    await prisma.subscription.create({
      data: { user_id: professor.id, tier: 'PRO' },
    });
  }

  // ============================================================================
  // 6. CREATE GIT ORGANIZATION & CLASSROOM
  // ============================================================================
  console.log('🏫 Creating classroom...');

  const gitOrg = await prisma.gitOrganization.upsert({
    where: {
      provider_provider_id: {
        provider: 'GITHUB',
        provider_id: CLASSMOJI_DEV_ORG_ID,
      },
    },
    update: {},
    create: {
      provider: 'GITHUB',
      provider_id: CLASSMOJI_DEV_ORG_ID,
      login: 'classmoji-development',
      github_installation_id: '100535756',
    },
  });

  const classroom = await prisma.classroom.upsert({
    where: { slug: 'classmoji-dev-winter-2025' },
    update: {},
    create: {
      git_org_id: gitOrg.id,
      slug: 'classmoji-dev-winter-2025',
      name: 'Classmoji Dev',
      term: 'WINTER',
      year: 2025,
    },
  });

  // ============================================================================
  // 7. CREATE CLASSROOM SETTINGS
  // ============================================================================
  await prisma.classroomSettings.upsert({
    where: { classroom_id: classroom.id },
    update: {},
    create: {
      classroom_id: classroom.id,
      show_grades_to_students: true,
      late_penalty_points_per_hour: 0.25,
      default_tokens_per_hour: 2,
      quizzes_enabled: true,
      slides_enabled: true,
      syllabus_bot_enabled: true,
    },
  });

  // ============================================================================
  // 8. CREATE CLASSROOM MEMBERSHIPS (delete existing to avoid duplicates)
  // ============================================================================
  console.log('👥 Creating classroom memberships...');

  await prisma.classroomMembership.deleteMany({
    where: { classroom_id: classroom.id },
  });

  const membershipData = [
    { user_id: professor.id, role: 'OWNER', is_grader: false },
    { user_id: instructor.id, role: 'OWNER', is_grader: false },
    { user_id: ta.id, role: 'ASSISTANT', is_grader: true },
    ...fakeTAs.map(t => ({ user_id: t.id, role: 'ASSISTANT', is_grader: true })),
    { user_id: student.id, role: 'STUDENT', is_grader: false },
    ...fakeStudents.map(s => ({ user_id: s.id, role: 'STUDENT', is_grader: false })),
  ];

  await prisma.classroomMembership.createMany({
    data: membershipData.map(m => ({
      classroom_id: classroom.id,
      user_id: m.user_id,
      role: m.role,
      is_grader: m.is_grader,
      has_accepted_invite: true,
    })),
  });

  // ============================================================================
  // 9. CREATE EMOJI & LETTER GRADE MAPPINGS
  // ============================================================================
  console.log('🎯 Creating emoji mappings...');

  for (const mapping of DEFAULT_EMOJI_MAPPINGS) {
    await prisma.emojiMapping.upsert({
      where: {
        classroom_id_emoji: {
          classroom_id: classroom.id,
          emoji: mapping.emoji,
        },
      },
      update: mapping,
      create: { classroom_id: classroom.id, ...mapping },
    });
  }

  for (const mapping of DEFAULT_LETTER_GRADE_MAPPINGS) {
    await prisma.letterGradeMapping.upsert({
      where: {
        classroom_id_letter_grade: {
          classroom_id: classroom.id,
          letter_grade: mapping.letter_grade,
        },
      },
      update: mapping,
      create: { classroom_id: classroom.id, ...mapping },
    });
  }

  // ============================================================================
  // 10. CREATE TAGS
  // ============================================================================
  console.log('🏷️  Creating tags...');

  const labsTag = await prisma.tag.upsert({
    where: {
      classroom_id_name: {
        classroom_id: classroom.id,
        name: 'Labs',
      },
    },
    update: {},
    create: { classroom_id: classroom.id, name: 'Labs' },
  });

  const finalProjectTag = await prisma.tag.upsert({
    where: {
      classroom_id_name: {
        classroom_id: classroom.id,
        name: 'Final Project',
      },
    },
    update: {},
    create: { classroom_id: classroom.id, name: 'Final Project' },
  });

  // ============================================================================
  // 11. CREATE TEAMS
  // ============================================================================
  console.log('👥 Creating teams...');

  const teamAlpha = await prisma.team.upsert({
    where: {
      classroom_id_slug: {
        classroom_id: classroom.id,
        slug: 'team-alpha',
      },
    },
    update: {},
    create: {
      classroom_id: classroom.id,
      name: 'Team Alpha',
      slug: 'team-alpha',
      is_visible: true,
    },
  });

  const teamBeta = await prisma.team.upsert({
    where: {
      classroom_id_slug: {
        classroom_id: classroom.id,
        slug: 'team-beta',
      },
    },
    update: {},
    create: {
      classroom_id: classroom.id,
      name: 'Team Beta',
      slug: 'team-beta',
      is_visible: true,
    },
  });

  // Add students to teams (2 per team)
  await prisma.teamMembership.deleteMany({
    where: { team_id: { in: [teamAlpha.id, teamBeta.id] } },
  });

  await prisma.teamMembership.createMany({
    data: [
      { team_id: teamAlpha.id, user_id: student.id },
      { team_id: teamAlpha.id, user_id: fakeStudents[0].id },
      { team_id: teamBeta.id, user_id: fakeStudents[1].id },
      { team_id: teamBeta.id, user_id: fakeStudents[2].id },
    ],
  });

  // Apply Final Project tag to teams
  await prisma.teamTag.deleteMany({
    where: { team_id: { in: [teamAlpha.id, teamBeta.id] } },
  });

  await prisma.teamTag.createMany({
    data: [
      { tag_id: finalProjectTag.id, team_id: teamAlpha.id },
      { tag_id: finalProjectTag.id, team_id: teamBeta.id },
    ],
  });

  // ============================================================================
  // 12. CREATE MODULES (upsert to preserve existing)
  // ============================================================================
  console.log('📚 Creating modules...');

  const moduleMap = {};
  for (const moduleData of MODULES) {
    const module = await prisma.module.upsert({
      where: {
        classroom_id_title: {
          classroom_id: classroom.id,
          title: moduleData.title,
        },
      },
      update: {
        // Update is_published to ensure seed data status is enforced
        is_published: moduleData.is_published,
      },
      create: {
        classroom_id: classroom.id,
        title: moduleData.title,
        template: moduleData.template,
        weight: moduleData.weight,
        type: moduleData.type,
        is_published: moduleData.is_published,
        tag_id: moduleData.title.startsWith('lab') ? labsTag.id : null,
      },
    });
    moduleMap[moduleData.title] = module;
  }

  // ============================================================================
  // 13. CREATE ASSIGNMENTS (upsert to preserve existing)
  // ============================================================================
  console.log('📝 Creating assignments...');

  const assignmentMap = {};
  for (const assignmentData of getAssignments()) {
    const module = moduleMap[assignmentData.module];
    const assignment = await prisma.assignment.upsert({
      where: {
        module_id_title: {
          module_id: module.id,
          title: assignmentData.title,
        },
      },
      update: {},
      create: {
        module_id: module.id,
        title: assignmentData.title,
        weight: assignmentData.weight,
        is_published: assignmentData.is_published,
        student_deadline: assignmentData.student_deadline,
        tokens_per_hour: assignmentData.tokens_per_hour,
      },
    });
    assignmentMap[`${assignmentData.module}:${assignmentData.title}`] = assignment;
  }

  // ============================================================================
  // 14. CREATE REPOSITORIES (skip existing to preserve GitHub links)
  // ============================================================================
  console.log('📁 Creating repositories...');

  const repoModules = ['hello-world', 'lab1-landing-page', 'starterpack'];
  const allRepos = [];

  for (const s of allStudents) {
    for (const moduleTitle of repoModules) {
      const module = moduleMap[moduleTitle];
      const repoName = `${moduleTitle}-${s.login}`;

      // Check if repo exists (preserve real GitHub links)
      let repo = await prisma.repository.findFirst({
        where: { name: repoName, classroom_id: classroom.id },
      });

      if (!repo) {
        repo = await prisma.repository.create({
          data: {
            provider: 'GITHUB',
            provider_id: generateFakeGitHubId(),
            name: repoName,
            classroom_id: classroom.id,
            module_id: module.id,
            student_id: s.id,
          },
        });
      }
      allRepos.push({ repo, student: s, module });
    }
  }

  // ============================================================================
  // 15. CREATE REPOSITORY ASSIGNMENTS (skip existing to preserve GitHub links)
  // ============================================================================
  console.log('📋 Creating repository assignments...');

  let issueCounter = 100;
  const allRepoAssignments = [];
  const allGraders = [ta, ...fakeTAs];
  let graderIndex = 0;

  for (let studentIdx = 0; studentIdx < allStudents.length; studentIdx++) {
    const s = allStudents[studentIdx];
    // Students 0-3 complete all work, students 4-5 have incomplete work
    const isCompleted = studentIdx < 4;

    const studentRepos = allRepos.filter(r => r.student.id === s.id);

    for (const { repo, module } of studentRepos) {
      // Get assignments for this module
      const moduleAssignments = Object.entries(assignmentMap)
        .filter(([key]) => key.startsWith(module.title + ':'))
        .map(([, assignment]) => assignment);

      for (const assignment of moduleAssignments) {
        // Check if RepositoryAssignment exists (preserve real GitHub links)
        let repoAssignment = await prisma.repositoryAssignment.findFirst({
          where: { repository_id: repo.id, assignment_id: assignment.id },
        });

        if (!repoAssignment) {
          repoAssignment = await prisma.repositoryAssignment.create({
            data: {
              provider: 'GITHUB',
              provider_id: generateFakeGitHubId(),
              provider_issue_number: issueCounter++,
              repository_id: repo.id,
              assignment_id: assignment.id,
              status: isCompleted ? 'CLOSED' : 'OPEN',
              closed_at: isCompleted ? dateInCurrentMonth(6 + studentIdx) : null,
            },
          });
        }

        allRepoAssignments.push({
          repoAssignment,
          student: s,
          isCompleted: repoAssignment.status === 'CLOSED',
          graderIndex: graderIndex++,
        });
      }
    }
  }

  // ============================================================================
  // 16. CREATE GRADER ASSIGNMENTS & GRADES
  // ============================================================================
  console.log('✏️  Creating grader assignments & grades...');

  const gradeEmojis = ['heart', '+1', 'eyes', '+1'];

  for (const { repoAssignment, isCompleted, graderIndex: gIdx } of allRepoAssignments) {
    const grader = allGraders[gIdx % allGraders.length];

    // Check if grader assignment exists
    const existingGraderAssignment = await prisma.repositoryAssignmentGrader.findFirst({
      where: {
        repository_assignment_id: repoAssignment.id,
        grader_id: grader.id,
      },
    });

    if (!existingGraderAssignment) {
      await prisma.repositoryAssignmentGrader.create({
        data: {
          repository_assignment_id: repoAssignment.id,
          grader_id: grader.id,
        },
      });
    }

    // Create grade if completed and no grade exists
    if (isCompleted) {
      const existingGrade = await prisma.assignmentGrade.findFirst({
        where: { repository_assignment_id: repoAssignment.id },
      });

      if (!existingGrade) {
        await prisma.assignmentGrade.create({
          data: {
            repository_assignment_id: repoAssignment.id,
            grader_id: grader.id,
            emoji: gradeEmojis[gIdx % gradeEmojis.length],
          },
        });
      }
    }
  }

  // ============================================================================
  // 17. CREATE REGRADE REQUESTS
  // ============================================================================
  console.log('🔄 Creating regrade requests...');

  // Get some graded repo assignments for regrade requests
  const gradedAssignments = allRepoAssignments.filter(ra => ra.isCompleted);

  if (gradedAssignments.length >= 5) {
    const regradeData = [
      {
        repoAssignmentIdx: 0,
        studentIdx: 0,
        status: 'APPROVED',
        student_comment: 'I believe my implementation is fully responsive as required by the rubric.',
        grader_comment: 'After review, bumping grade from eyes to +1.',
        previous_grade: ['eyes'],
      },
      {
        repoAssignmentIdx: 1,
        studentIdx: 0,
        status: 'DENIED',
        student_comment: 'The auto-grader missed my edge case handling.',
        grader_comment: 'Edge cases were not implemented as specified. Grade stands.',
        previous_grade: ['+1'],
      },
      {
        repoAssignmentIdx: 2,
        studentIdx: 1,
        status: 'IN_REVIEW',
        student_comment: 'I think I deserve full credit for this assignment.',
        grader_comment: null,
        previous_grade: ['eyes'],
      },
      {
        repoAssignmentIdx: 3,
        studentIdx: 2,
        status: 'APPROVED',
        student_comment: 'My CSS animations work correctly, just needed more testing.',
        grader_comment: 'Confirmed animations work. Bumping to heart.',
        previous_grade: ['+1'],
      },
      {
        repoAssignmentIdx: 4,
        studentIdx: 3,
        status: 'IN_REVIEW',
        student_comment: 'Please review my commit history to see my progress.',
        grader_comment: null,
        previous_grade: ['eyes'],
      },
    ];

    for (const rd of regradeData) {
      const ra = gradedAssignments[rd.repoAssignmentIdx];
      const studentUser = allStudents[rd.studentIdx];

      const existingRequest = await prisma.regradeRequest.findFirst({
        where: {
          repository_assignment_id: ra.repoAssignment.id,
          student_id: studentUser.id,
        },
      });

      if (!existingRequest) {
        await prisma.regradeRequest.create({
          data: {
            repository_assignment_id: ra.repoAssignment.id,
            classroom_id: classroom.id,
            student_id: studentUser.id,
            status: rd.status,
            student_comment: rd.student_comment,
            grader_comment: rd.grader_comment,
            previous_grade: rd.previous_grade,
          },
        });
      }
    }
  }

  // ============================================================================
  // 18. CREATE QUIZZES (definitions only)
  // ============================================================================
  console.log('📝 Creating quizzes...');

  const quizzes = [
    {
      name: 'Intro to JavaScript',
      rubric_prompt: `Evaluate the student's understanding of JavaScript fundamentals:
- Variables and data types
- Functions and scope
- Arrays and objects
- Control flow (if/else, loops)
Award partial credit for demonstrating understanding even with minor syntax errors.`,
      question_count: 3,
      difficulty_level: 'Beginner',
      include_code_context: false,
      status: 'PUBLISHED',
      max_attempts: 3,
      weight: 10,
    },
    {
      name: 'React Intermediate Quiz',
      rubric_prompt: `Assess the student's understanding of React concepts:
- Functional components and hooks (useState, useEffect)
- Props and state management
- Event handling
- Conditional rendering
Students should be able to read their own code and explain their implementation.`,
      question_count: 5,
      difficulty_level: 'Intermediate',
      include_code_context: true,
      status: 'PUBLISHED',
      max_attempts: 2,
      weight: 15,
    },
  ];

  // Use findFirst + create pattern for quizzes (no unique constraint on name)
  for (const quizData of quizzes) {
    const existingQuiz = await prisma.quiz.findFirst({
      where: { classroom_id: classroom.id, name: quizData.name },
    });

    if (!existingQuiz) {
      await prisma.quiz.create({
        data: {
          classroom_id: classroom.id,
          name: quizData.name,
          rubric_prompt: quizData.rubric_prompt,
          question_count: quizData.question_count,
          difficulty_level: quizData.difficulty_level,
          include_code_context: quizData.include_code_context,
          status: quizData.status,
          max_attempts: quizData.max_attempts,
          weight: quizData.weight,
        },
      });
    }
  }

  // ============================================================================
  // 19. CREATE TOKEN TRANSACTIONS
  // ============================================================================
  console.log('💰 Creating token transactions...');

  // Get first repo assignment for linking purchases
  const emmaStudent = fakeStudents[0];
  const liamStudent = fakeStudents[1];
  const oliviaStudent = fakeStudents[2];
  const noahStudent = fakeStudents[3];

  // Token grants
  const tokenGrants = [
    { student: emmaStudent, amount: 10, description: 'Initial token grant' },
    { student: liamStudent, amount: 10, description: 'Initial token grant' },
    { student: oliviaStudent, amount: 8, description: 'Participation bonus' },
    { student: noahStudent, amount: 6, description: 'Office hours attendance' },
  ];

  let balance = 0;
  for (const grant of tokenGrants) {
    balance = grant.amount;
    const existingGrant = await prisma.tokenTransaction.findFirst({
      where: {
        classroom_id: classroom.id,
        student_id: grant.student.id,
        type: 'GAIN',
        description: grant.description,
      },
    });

    if (!existingGrant) {
      await prisma.tokenTransaction.create({
        data: {
          classroom_id: classroom.id,
          student_id: grant.student.id,
          amount: grant.amount,
          type: 'GAIN',
          balance_after: balance,
          description: grant.description,
        },
      });
    }
  }

  // Token purchases (emma and noah)
  const emmaPurchase = await prisma.tokenTransaction.findFirst({
    where: {
      classroom_id: classroom.id,
      student_id: emmaStudent.id,
      type: 'PURCHASE',
    },
  });

  if (!emmaPurchase) {
    await prisma.tokenTransaction.create({
      data: {
        classroom_id: classroom.id,
        student_id: emmaStudent.id,
        amount: -4,
        type: 'PURCHASE',
        hours_purchased: 2,
        balance_after: 6,
        description: '2-hour extension on Lab 1 Part 1',
      },
    });
  }

  const noahPurchase = await prisma.tokenTransaction.findFirst({
    where: {
      classroom_id: classroom.id,
      student_id: noahStudent.id,
      type: 'PURCHASE',
    },
  });

  if (!noahPurchase) {
    await prisma.tokenTransaction.create({
      data: {
        classroom_id: classroom.id,
        student_id: noahStudent.id,
        amount: -6,
        type: 'PURCHASE',
        hours_purchased: 3,
        balance_after: 0,
        description: '3-hour extension on Vite StarterPack',
      },
    });
  }

  // Token refund (emma)
  const emmaRefund = await prisma.tokenTransaction.findFirst({
    where: {
      classroom_id: classroom.id,
      student_id: emmaStudent.id,
      type: 'REFUND',
    },
  });

  if (!emmaRefund) {
    await prisma.tokenTransaction.create({
      data: {
        classroom_id: classroom.id,
        student_id: emmaStudent.id,
        amount: 2,
        type: 'REFUND',
        balance_after: 8,
        description: 'Refund for deadline extension issue',
      },
    });
  }

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n✅ Seed completed successfully!\n');
  console.log('📊 Summary:');
  console.log(`   Real Users: 4 (professor, instructor, ta, student)`);
  console.log(`   Fake TAs: ${fakeTAs.length}`);
  console.log(`   Fake Students: ${fakeStudents.length}`);
  console.log(`   Total Users: ${4 + fakeTAs.length + fakeStudents.length}`);
  console.log(`   Teams: 2 (Alpha, Beta)`);
  console.log(`   Tags: 2 (Labs, Final Project)`);
  console.log(`   Modules: ${Object.keys(moduleMap).length}`);
  console.log(`   Assignments: ${Object.keys(assignmentMap).length}`);
  console.log(`   Repositories: ${allRepos.length}`);
  console.log(`   Repository Assignments: ${allRepoAssignments.length}`);
  console.log(`   Quizzes: 2`);
  console.log(`\n🏫 Classroom: ${classroom.name} (slug: ${classroom.slug})`);
  console.log(`🏢 Git Org: ${gitOrg.login}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
