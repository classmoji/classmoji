/* eslint-disable no-console */
/**
 * Seed richer demo data into the existing "Dev Classroom" for frontend testing.
 *
 * Idempotent: keyed on `provider + provider_id` pairs prefixed with
 * DEMO_PREFIX so re-runs upsert rather than duplicate. Prior, un-prefixed
 * fixtures created by scripts/seed.js are left alone.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DEMO_PREFIX = '9e'; // picks a distinct numeric range
const CLASSROOM_SLUG = 'classmoji-dev-winter-2025';

// Deterministic PRNG so repeated runs produce identical histories
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (lo, hi) => Math.floor(rand() * (hi - lo + 1)) + lo;

const STUDENT_NAMES = [
  'Ava Nakamura', 'Marcus Obi', 'Priya Shah', 'Liam Henriksen', 'Chen Wei',
  'Olivia Park', 'Kofi Mensah', 'Sienna Russo', 'Noah Bergmann', 'Tara Iyer',
  'Elena Moreno', 'Jamal Rashid', 'Zara Khan', 'Ethan Cole', 'Maya Delacroix',
  'Ravi Kapoor', 'Sofia Larsen', 'Dmitri Volkov', 'Hana Ito', 'Leo Cardoso',
  'Amara Okafor', 'Finn O\'Sullivan', 'Ines Beltran', 'Kenji Matsuda', 'Aisha Bello',
  'Theo Andersen',
];

const TA_NAMES = ['Riley Chen', 'Sam Alvarado'];

const MODULES_SPEC = [
  { title: 'Module 1 — Foundations', template: 'foundations', type: 'INDIVIDUAL', assignments: 4 },
  { title: 'Module 2 — State Management', template: 'state-mgmt', type: 'INDIVIDUAL', assignments: 5 },
  { title: 'Module 3 — Routing & API', template: 'routing-api', type: 'INDIVIDUAL', assignments: 6 },
  { title: 'Module 4 — Capstone Projects', template: 'projects', type: 'GROUP', assignments: 5 },
];

const EMOJI_BY_BUCKET = ['🟢', '🟢', '🟢', '🟡', '🟡', '🔴', '⭐'];

async function ensureUser({ name, login, email, providerId }) {
  const existing = await prisma.user.findUnique({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: providerId } },
  });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      provider: 'GITHUB',
      provider_id: providerId,
      login,
      email,
      emailVerified: true,
      name,
    },
  });
}

async function ensureMembership(classroomId, userId, role) {
  await prisma.classroomMembership.upsert({
    where: { classroom_id_user_id_role: { classroom_id: classroomId, user_id: userId, role } },
    update: {},
    create: { classroom_id: classroomId, user_id: userId, role },
  });
}

async function ensureModule(classroomId, spec) {
  const existing = await prisma.module.findFirst({
    where: { classroom_id: classroomId, title: spec.title },
  });
  if (existing) return existing;
  return prisma.module.create({
    data: {
      classroom_id: classroomId,
      title: spec.title,
      slug: spec.template,
      template: spec.template,
      type: spec.type,
      is_published: true,
      weight: 100,
    },
  });
}

async function ensureAssignment(moduleRow, title, deadlineOffsetDays, isClosed) {
  const deadline = new Date(Date.now() + deadlineOffsetDays * 86_400_000);
  const existing = await prisma.assignment.findFirst({
    where: { module_id: moduleRow.id, title },
  });
  if (existing) return existing;
  return prisma.assignment.create({
    data: {
      module_id: moduleRow.id,
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
      is_published: true,
      weight: 100,
      description: `Demo seed for ${title}.`,
      student_deadline: deadline,
      grader_deadline: new Date(deadline.getTime() + 7 * 86_400_000),
      release_at: new Date(deadline.getTime() - 14 * 86_400_000),
      grades_released: isClosed,
    },
  });
}

function providerId(prefix, tail) {
  return `${DEMO_PREFIX}${prefix}${String(tail).padStart(6, '0')}`;
}

async function ensureRepository({ classroomId, moduleRow, studentId, teamId, name, providerSeq }) {
  const pid = providerId('repo', providerSeq);
  const existing = await prisma.repository.findUnique({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: pid } },
  });
  if (existing) return existing;
  return prisma.repository.create({
    data: {
      provider: 'GITHUB',
      provider_id: pid,
      name,
      classroom_id: classroomId,
      module_id: moduleRow.id,
      student_id: studentId ?? null,
      team_id: teamId ?? null,
    },
  });
}

async function ensureRepositoryAssignment({ repositoryId, assignmentId, issueNumber, closedAt, providerSeq }) {
  const pid = providerId('ra', providerSeq);
  const existing = await prisma.repositoryAssignment.findUnique({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: pid } },
  });
  if (existing) {
    if ((existing.closed_at && !closedAt) || (!existing.closed_at && closedAt)) {
      await prisma.repositoryAssignment.update({
        where: { id: existing.id },
        data: { closed_at: closedAt, status: closedAt ? 'CLOSED' : 'OPEN' },
      });
    }
    return existing;
  }
  return prisma.repositoryAssignment.create({
    data: {
      provider: 'GITHUB',
      provider_id: pid,
      provider_issue_number: issueNumber,
      repository_id: repositoryId,
      assignment_id: assignmentId,
      status: closedAt ? 'CLOSED' : 'OPEN',
      closed_at: closedAt,
    },
  });
}

function synthesizeCommits({ login, name, deadline, count, mode, teamContributors }) {
  // mode: 'steady' | 'crunch' | 'late' | 'single-author' | 'dumpAndRun'
  const deadlineMs = deadline.getTime();
  const startMs = deadlineMs - 10 * 86_400_000;
  const commits = [];
  const contributorTotals = new Map();
  const contribList = teamContributors ?? [{ login, name }];

  for (let i = 0; i < count; i++) {
    let ts;
    if (mode === 'crunch') {
      ts = i < count * 0.15
        ? startMs + (deadlineMs - startMs) * 0.3 * (i / (count * 0.15))
        : deadlineMs - 23 * 3_600_000 + (i - count * 0.15) / (count * 0.85) * 22 * 3_600_000;
    } else if (mode === 'late') {
      ts = startMs + (i / count) * (deadlineMs - startMs) + (i > count * 0.8 ? 5 * 3_600_000 : 0);
    } else if (mode === 'dumpAndRun') {
      ts = deadlineMs - (count - i) * 45 * 60 * 1000; // packed inside last 12h
    } else {
      // steady
      ts = startMs + (i / count) * (deadlineMs - startMs - 4 * 3_600_000) + rand() * 3_600_000;
    }
    const author = mode === 'single-author' ? contribList[0] : pick(contribList);
    const additions = randInt(3, 180);
    const deletions = randInt(0, 60);
    const msg = pick([
      'feat: initial implementation',
      'fix: tests passing',
      'wip',
      'refactor store layer',
      'add tests for edge cases',
      'cleanup',
      'fix: typo',
      'docs: update readme',
      'feat: cart slice + routes',
      'refactor: split components',
      'tweak spacing',
      'handle error path',
    ]);
    const id = `${DEMO_PREFIX}${Math.floor(ts).toString(16).slice(-10)}${i.toString(16).padStart(2,'0')}`;
    commits.push({
      sha: id,
      ts: new Date(ts).toISOString(),
      author_login: author.login,
      author_name: author.name,
      message: msg,
      additions,
      deletions,
    });
    const prev = contributorTotals.get(author.login) ?? { login: author.login, commits: 0, additions: 0, deletions: 0 };
    prev.commits += 1;
    prev.additions += additions;
    prev.deletions += deletions;
    contributorTotals.set(author.login, prev);
  }
  commits.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return {
    commits,
    contributors: Array.from(contributorTotals.values()),
    totalAdd: commits.reduce((s, c) => s + c.additions, 0),
    totalDel: commits.reduce((s, c) => s + c.deletions, 0),
  };
}

async function upsertSnapshot(repositoryAssignmentId, payload) {
  const { commits, contributors, totalAdd, totalDel } = payload;
  const langs = { JavaScript: 72, CSS: 14, HTML: 8, TypeScript: 6 };
  const prSummary = { open: randInt(0, 2), merged: randInt(0, 3), closed: randInt(0, 1) };
  const firstTs = commits[0]?.ts ? new Date(commits[0].ts) : null;
  const lastTs = commits[commits.length - 1]?.ts ? new Date(commits[commits.length - 1].ts) : null;
  const data = {
    fetched_at: new Date(),
    default_branch: 'main',
    total_commits: commits.length,
    total_additions: totalAdd,
    total_deletions: totalDel,
    first_commit_at: firstTs,
    last_commit_at: lastTs,
    commits,
    contributors: contributors.map((c) => ({ ...c, user_id: null })),
    languages: langs,
    pr_summary: prSummary,
    stale: false,
    error: null,
  };
  await prisma.repoAnalyticsSnapshot.upsert({
    where: { repository_assignment_id: repositoryAssignmentId },
    update: data,
    create: { repository_assignment_id: repositoryAssignmentId, ...data },
  });
}

async function main() {
  const classroom = await prisma.classroom.findUnique({ where: { slug: CLASSROOM_SLUG } });
  if (!classroom) throw new Error(`Classroom ${CLASSROOM_SLUG} not found`);
  console.log(`→ classroom ${classroom.name} (${classroom.id})`);

  // 1) Ensure ~26 students and 2 extra TAs.
  const students = [];
  for (let i = 0; i < STUDENT_NAMES.length; i++) {
    const name = STUDENT_NAMES[i];
    const login = `demo-${name.toLowerCase().split(' ')[0].replace(/'/g, '')}-${i + 1}`;
    const email = `${login}@demo.classmoji.local`;
    const user = await ensureUser({ name, login, email, providerId: providerId('stu', i + 1) });
    await ensureMembership(classroom.id, user.id, 'STUDENT');
    students.push(user);
  }
  console.log(`✓ ${students.length} students`);

  const tas = [];
  for (let i = 0; i < TA_NAMES.length; i++) {
    const name = TA_NAMES[i];
    const login = `demo-ta-${i + 1}`;
    const user = await ensureUser({
      name, login, email: `${login}@demo.classmoji.local`,
      providerId: providerId('ta', i + 1),
    });
    await ensureMembership(classroom.id, user.id, 'ASSISTANT');
    tas.push(user);
  }
  // existing TAs
  const existingTaRows = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroom.id, role: 'ASSISTANT' },
    select: { user: true },
  });
  const allGraders = [...new Set([...existingTaRows.map((r) => r.user), ...tas].map((u) => u.id))]
    .map((id) => [...existingTaRows.map((r) => r.user), ...tas].find((u) => u.id === id));
  console.log(`✓ ${allGraders.length} graders available`);

  // 2) Modules
  const modules = [];
  for (const spec of MODULES_SPEC) {
    modules.push({ row: await ensureModule(classroom.id, spec), spec });
  }
  console.log(`✓ ${modules.length} modules`);

  // 3) Assignments (20 total; mix of done/in-progress/future)
  const assignments = [];
  let asnSeq = 0;
  for (const { row: mod, spec } of modules) {
    for (let i = 1; i <= spec.assignments; i++) {
      asnSeq += 1;
      const offsetDays = asnSeq <= 10
        ? -asnSeq * 3 // past
        : asnSeq === 11
          ? 0
          : (asnSeq - 11) * 3; // future
      const isClosed = offsetDays < 0;
      const title = `${mod.title.split(' — ')[1]} · A${i}`;
      const asn = await ensureAssignment(mod, title, offsetDays, isClosed);
      assignments.push({ row: asn, module: mod, spec, offsetDays, isClosed });
    }
  }
  console.log(`✓ ${assignments.length} assignments`);

  // 4) Teams for GROUP modules (6 teams of ~4 students each).
  const groupModules = modules.filter((m) => m.spec.type === 'GROUP');
  const teamsByModule = new Map();
  for (const { row: mod } of groupModules) {
    const count = 6;
    const teamRows = [];
    for (let t = 0; t < count; t++) {
      const name = `Team ${String.fromCharCode(65 + t)}`;
      const slug = `${mod.slug}-team-${String.fromCharCode(97 + t)}`;
      let team = await prisma.team.findUnique({
        where: { classroom_id_slug: { classroom_id: classroom.id, slug } },
      });
      if (!team) {
        team = await prisma.team.create({
          data: {
            classroom_id: classroom.id,
            name,
            slug,
            provider: 'GITHUB',
            provider_id: providerId('team', t + 1 + (mod.id.charCodeAt(0) % 10)),
            is_visible: true,
          },
        });
        // Assign ~4 students round-robin
        const memberStudents = [];
        for (let k = 0; k < 4; k++) {
          memberStudents.push(students[(t * 4 + k) % students.length]);
        }
        for (const s of memberStudents) {
          await prisma.teamMembership.upsert({
            where: { team_id_user_id: { team_id: team.id, user_id: s.id } },
            update: {},
            create: { team_id: team.id, user_id: s.id },
          });
        }
      }
      teamRows.push(team);
    }
    teamsByModule.set(mod.id, teamRows);
  }
  console.log(`✓ teams built for ${teamsByModule.size} group module(s)`);

  // 5) For each assignment: repos + repository_assignments + snapshots + grades
  let repoSeq = 0;
  let raSeq = 0;
  let gradesCreated = 0;
  let snapshotsCreated = 0;

  for (const { row: asn, module, spec, offsetDays, isClosed } of assignments) {
    const deadline = asn.student_deadline ?? new Date(Date.now() + offsetDays * 86_400_000);
    if (spec.type === 'INDIVIDUAL') {
      for (const stu of students) {
        repoSeq += 1;
        raSeq += 1;
        // Skip roughly 12% to simulate non-submitters on past assignments
        const submitted = isClosed ? rand() > 0.12 : rand() > 0.5;
        const repo = await ensureRepository({
          classroomId: classroom.id,
          moduleRow: module,
          studentId: stu.id,
          name: `${module.slug}-${stu.login}-a${asn.id.slice(0, 4)}`,
          providerSeq: repoSeq,
        });
        const submittedAt = submitted
          ? new Date(deadline.getTime() + (rand() > 0.75 ? rand() * 5 * 3_600_000 : -rand() * 36 * 3_600_000))
          : null;
        const ra = await ensureRepositoryAssignment({
          repositoryId: repo.id,
          assignmentId: asn.id,
          issueNumber: raSeq,
          closedAt: submittedAt,
          providerSeq: raSeq,
        });

        if (submitted) {
          const mode = rand() > 0.82 ? 'crunch' : rand() > 0.95 ? 'dumpAndRun' : rand() > 0.9 ? 'late' : 'steady';
          const payload = synthesizeCommits({
            login: stu.login, name: stu.name ?? stu.login,
            deadline, count: randInt(4, 18), mode,
          });
          await upsertSnapshot(ra.id, payload);
          snapshotsCreated += 1;
        }

        // Grade ~70% of submitted-and-closed-past submissions
        if (submitted && isClosed && rand() > 0.3) {
          const grader = pick(allGraders);
          const bucket = pick(EMOJI_BY_BUCKET);
          const existingGrade = await prisma.assignmentGrade.findFirst({
            where: { repository_assignment_id: ra.id },
          });
          if (!existingGrade) {
            await prisma.assignmentGrade.create({
              data: {
                repository_assignment_id: ra.id,
                grader_id: grader.id,
                emoji: bucket,
                created_at: new Date(
                  submittedAt.getTime() + randInt(2, 36) * 3_600_000,
                ),
              },
            });
            gradesCreated += 1;
          }
        } else if (submitted) {
          // Assign a grader (for backlog counts) when ungraded
          const grader = pick(allGraders);
          await prisma.repositoryAssignmentGrader.upsert({
            where: {
              repository_assignment_id_grader_id: {
                repository_assignment_id: ra.id,
                grader_id: grader.id,
              },
            },
            update: {},
            create: { repository_assignment_id: ra.id, grader_id: grader.id },
          });
        }
      }
    } else {
      // GROUP
      const teams = teamsByModule.get(module.id) ?? [];
      for (const team of teams) {
        repoSeq += 1;
        raSeq += 1;
        const submitted = isClosed ? rand() > 0.15 : rand() > 0.55;
        const repo = await ensureRepository({
          classroomId: classroom.id,
          moduleRow: module,
          teamId: team.id,
          name: `${module.slug}-${team.slug}`,
          providerSeq: repoSeq,
        });
        const submittedAt = submitted
          ? new Date(deadline.getTime() + (rand() > 0.8 ? rand() * 4 * 3_600_000 : -rand() * 24 * 3_600_000))
          : null;
        const ra = await ensureRepositoryAssignment({
          repositoryId: repo.id,
          assignmentId: asn.id,
          issueNumber: raSeq,
          closedAt: submittedAt,
          providerSeq: raSeq,
        });

        if (submitted) {
          const members = await prisma.teamMembership.findMany({
            where: { team_id: team.id },
            select: { user: { select: { login: true, name: true } } },
          });
          const contribList = members
            .map((m) => ({ login: m.user.login ?? 'unknown', name: m.user.name ?? m.user.login ?? 'unknown' }));
          const mode = rand() > 0.75 ? 'single-author' : 'steady';
          const payload = synthesizeCommits({
            login: contribList[0].login, name: contribList[0].name,
            deadline, count: randInt(25, 80), mode,
            teamContributors: contribList,
          });
          await upsertSnapshot(ra.id, payload);
          snapshotsCreated += 1;
        }

        if (submitted && isClosed && rand() > 0.35) {
          const grader = pick(allGraders);
          const bucket = pick(EMOJI_BY_BUCKET);
          const existingGrade = await prisma.assignmentGrade.findFirst({
            where: { repository_assignment_id: ra.id },
          });
          if (!existingGrade) {
            await prisma.assignmentGrade.create({
              data: {
                repository_assignment_id: ra.id,
                grader_id: grader.id,
                emoji: bucket,
                created_at: new Date(
                  submittedAt.getTime() + randInt(4, 40) * 3_600_000,
                ),
              },
            });
            gradesCreated += 1;
          }
        } else if (submitted) {
          const grader = pick(allGraders);
          await prisma.repositoryAssignmentGrader.upsert({
            where: {
              repository_assignment_id_grader_id: {
                repository_assignment_id: ra.id,
                grader_id: grader.id,
              },
            },
            update: {},
            create: { repository_assignment_id: ra.id, grader_id: grader.id },
          });
        }
      }
    }
  }
  console.log(`✓ ${snapshotsCreated} snapshots, ${gradesCreated} grades`);

  // 6) A handful of regrade requests
  const gradedRows = await prisma.assignmentGrade.findMany({
    where: {
      repository_assignment: {
        repository: { classroom_id: classroom.id },
      },
    },
    select: {
      emoji: true,
      repository_assignment_id: true,
      repository_assignment: { select: { repository: { select: { student_id: true, team: { select: { memberships: { take: 1, select: { user_id: true } } } } } } } },
    },
    take: 8,
  });
  let regradeCount = 0;
  for (const g of gradedRows) {
    const studentId = g.repository_assignment.repository.student_id
      ?? g.repository_assignment.repository.team?.memberships?.[0]?.user_id
      ?? null;
    if (!studentId) continue;
    const existing = await prisma.regradeRequest.findFirst({
      where: { repository_assignment_id: g.repository_assignment_id, student_id: studentId },
    });
    if (existing) continue;
    await prisma.regradeRequest.create({
      data: {
        repository_assignment_id: g.repository_assignment_id,
        classroom_id: classroom.id,
        student_id: studentId,
        student_comment: 'Could you take another look?',
        previous_grade: [g.emoji],
        status: pick(['IN_REVIEW', 'APPROVED', 'DENIED']),
      },
    });
    regradeCount += 1;
  }
  console.log(`✓ ${regradeCount} regrade requests`);

  console.log('\n🌱 Dev Classroom seeded.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
