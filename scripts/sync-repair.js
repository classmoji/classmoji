#!/usr/bin/env node
/**
 * Sync Repair Tool
 *
 * Audits repos and issues against GitHub to detect and fix:
 * - Stale repos (DB record exists but GitHub repo doesn't)
 * - Stale issues (DB record exists but GitHub issue doesn't)
 * - ID mismatches (repo/issue exists but provider_id doesn't match)
 *
 * Usage: node scripts/sync-repair.js
 *        (loads DATABASE_URL from .dev-context automatically)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';

// ALWAYS read DATABASE_URL from .dev-context for local dev
const __dirname = dirname(fileURLToPath(import.meta.url));
const devContextPath = join(__dirname, '..', '.dev-context');

try {
  const devContext = readFileSync(devContextPath, 'utf8');
  const dbUrlMatch = devContext.match(/URL:\s*(postgresql:\/\/[^\s]+)/);
  if (dbUrlMatch) {
    process.env.DATABASE_URL = dbUrlMatch[1];
    console.log(`📊 Using database from .dev-context: ${process.env.DATABASE_URL.split('@')[1]}\n`);
  }
} catch (e) {
  console.log('⚠️  No .dev-context found, using DATABASE_URL from environment\n');
}

// Dynamic imports AFTER setting DATABASE_URL so Prisma uses the right connection
const { getGitProvider } = await import('@classmoji/services');
const { default: prisma } = await import('@classmoji/database');

// Interactive prompt helper
const prompt = question => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    })
  );
};

async function selectClassroom() {
  const classrooms = await prisma.classroom.findMany({
    include: { git_organization: true },
    orderBy: { name: 'asc' },
  });

  if (classrooms.length === 0) {
    console.log('❌ No classrooms found in database');
    return null;
  }

  console.log('\n📚 Available Classrooms:\n');
  classrooms.forEach((c, i) => console.log(`  ${i + 1}. ${c.name} (${c.slug})`));

  const choice = await prompt('\nSelect classroom number: ');
  const index = parseInt(choice) - 1;

  if (index < 0 || index >= classrooms.length) {
    console.log('❌ Invalid selection');
    return null;
  }

  return classrooms[index];
}

async function selectModule(classroomId) {
  const modules = await prisma.module.findMany({
    where: { classroom_id: classroomId },
    include: { assignments: true },
    orderBy: { title: 'asc' },
  });

  if (modules.length === 0) {
    console.log('❌ No modules found for this classroom');
    return null;
  }

  console.log('\n📦 Available Modules:\n');
  modules.forEach((m, i) => console.log(`  ${i + 1}. ${m.title} (${m.assignments.length} assignments)`));

  const choice = await prompt('\nSelect module number: ');
  const index = parseInt(choice) - 1;

  if (index < 0 || index >= modules.length) {
    console.log('❌ Invalid selection');
    return null;
  }

  return modules[index];
}

async function auditAndRepair(classroom, module) {
  const gitProvider = getGitProvider(classroom.git_organization);
  const orgLogin = classroom.git_organization.login;

  // Get all repos for this module
  const repos = await prisma.repository.findMany({
    where: { module_id: module.id, classroom_id: classroom.id },
    include: {
      assignments: true,
      student: true,
      team: true,
    },
  });

  console.log(`\n🔍 Auditing ${repos.length} repositories...\n`);

  const issues = { staleRepos: [], staleIssues: [], idMismatches: [], missingIssues: [] };

  for (const repo of repos) {
    const owner = repo.student?.name || repo.team?.name || 'unknown';
    process.stdout.write(`  Checking ${repo.name} (${owner})... `);

    // 1. Check if repo exists on GitHub
    let githubRepo;
    try {
      githubRepo = await gitProvider.getRepository(orgLogin, repo.name);
    } catch (e) {
      // 404 = not found, 410 = deleted
      if (e.status === 404 || e.status === 410) {
        console.log('❌ REPO NOT FOUND');
        issues.staleRepos.push(repo);
        continue;
      }
      throw e;
    }

    // 2. Check repo ID match
    if (githubRepo.id !== repo.provider_id) {
      console.log(`⚠️  REPO ID MISMATCH (DB: ${repo.provider_id}, GitHub: ${githubRepo.id})`);
      issues.idMismatches.push({ type: 'repo', record: repo, githubId: githubRepo.id });
    }

    // 3. Check each issue/assignment
    for (const repoAssignment of repo.assignments) {
      try {
        // Get issue by number from GitHub
        const githubIssue = await gitProvider.getIssue(
          orgLogin,
          repo.name,
          repoAssignment.provider_issue_number
        );

        // Check issue ID match
        if (String(githubIssue.id) !== repoAssignment.provider_id) {
          issues.idMismatches.push({
            type: 'issue',
            record: repoAssignment,
            githubId: String(githubIssue.id),
            repoName: repo.name,
          });
        }
      } catch (e) {
        // 404 = not found, 410 = deleted (GitHub returns 410 for deleted issues)
        if (e.status === 404 || e.status === 410) {
          issues.staleIssues.push({ record: repoAssignment, repoName: repo.name });
        } else {
          throw e;
        }
      }
    }

    // 4. Check for missing issues (assignment exists but no RepositoryAssignment)
    const existingAssignmentIds = repo.assignments.map(a => a.assignment_id);
    for (const assignment of module.assignments) {
      if (!existingAssignmentIds.includes(assignment.id)) {
        issues.missingIssues.push({ repo, assignment });
      }
    }

    if (!issues.idMismatches.find(m => m.record.id === repo.id)) {
      console.log('✓');
    }
  }

  // Report findings
  console.log('\n📊 Audit Results:\n');
  console.log(`  Stale repos (DB record, no GitHub):     ${issues.staleRepos.length}`);
  console.log(`  Stale issues (DB record, no GitHub):    ${issues.staleIssues.length}`);
  console.log(`  ID mismatches:                          ${issues.idMismatches.length}`);
  console.log(`  Missing issues (no DB record):          ${issues.missingIssues.length}`);

  // Show details
  if (issues.staleRepos.length > 0) {
    console.log('\n  📁 Stale repos:');
    for (const repo of issues.staleRepos) {
      const owner = repo.student?.name || repo.team?.name || 'unknown';
      console.log(`     - ${repo.name} (${owner})`);
    }
  }

  if (issues.staleIssues.length > 0) {
    console.log('\n  📋 Stale issues:');
    for (const { record, repoName } of issues.staleIssues) {
      console.log(`     - ${repoName} #${record.provider_issue_number}`);
    }
  }

  if (issues.idMismatches.length > 0) {
    console.log('\n  🔀 ID mismatches:');
    for (const mismatch of issues.idMismatches) {
      if (mismatch.type === 'repo') {
        console.log(`     - Repo ${mismatch.record.name}: DB=${mismatch.record.provider_id} → GitHub=${mismatch.githubId}`);
      } else {
        console.log(`     - Issue ${mismatch.repoName} #${mismatch.record.provider_issue_number}: DB=${mismatch.record.provider_id} → GitHub=${mismatch.githubId}`);
      }
    }
  }

  if (issues.missingIssues.length > 0) {
    console.log('\n  ➕ Missing issues (run Sync in UI to create):');
    for (const { repo, assignment } of issues.missingIssues) {
      console.log(`     - ${repo.name} missing: ${assignment.title}`);
    }
  }

  const repairableCount = issues.staleRepos.length + issues.staleIssues.length + issues.idMismatches.length;

  if (repairableCount === 0) {
    console.log('\n✅ No repairable issues found!');
    if (issues.missingIssues.length > 0) {
      console.log('   Run Sync from the UI to create missing issues.\n');
    }
    return;
  }

  // Ask to repair
  const repair = await prompt('\nRepair issues? (y/n): ');
  if (repair.toLowerCase() !== 'y') {
    console.log('Skipping repairs.\n');
    return;
  }

  console.log('\n🔧 Repairing...\n');

  // Repair stale repos (delete DB records)
  for (const repo of issues.staleRepos) {
    console.log(`  Deleting stale repo record: ${repo.name}`);
    await prisma.repository.delete({ where: { id: repo.id } });
  }

  // Repair stale issues (delete DB records)
  for (const { record, repoName } of issues.staleIssues) {
    console.log(`  Deleting stale issue record: ${repoName} #${record.provider_issue_number}`);
    await prisma.repositoryAssignment.delete({ where: { id: record.id } });
  }

  // Repair ID mismatches (update DB to match GitHub)
  for (const mismatch of issues.idMismatches) {
    if (mismatch.type === 'repo') {
      console.log(`  Fixing repo ID: ${mismatch.record.name} → ${mismatch.githubId}`);
      await prisma.repository.update({
        where: { id: mismatch.record.id },
        data: { provider_id: mismatch.githubId },
      });
    } else {
      console.log(`  Fixing issue ID: ${mismatch.repoName} #${mismatch.record.provider_issue_number} → ${mismatch.githubId}`);
      await prisma.repositoryAssignment.update({
        where: { id: mismatch.record.id },
        data: { provider_id: mismatch.githubId },
      });
    }
  }

  console.log('\n✅ Repairs complete! Run Sync from UI to create any missing items.\n');
}

// Main
async function main() {
  console.log('🔧 Sync Repair Tool\n');

  const classroom = await selectClassroom();
  if (!classroom) {
    await prisma.$disconnect();
    return;
  }

  const module = await selectModule(classroom.id);
  if (!module) {
    await prisma.$disconnect();
    return;
  }

  console.log(`\n📍 Selected: ${classroom.name} → ${module.title}`);

  await auditAndRepair(classroom, module);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
