#!/usr/bin/env node
/**
 * Cleanup orphaned GitHub teams
 *
 * This script lists all teams in the GitHub organization and identifies
 * which ones are orphaned (not matching any active classroom).
 *
 * Usage: node scripts/cleanup-github-teams.js [--delete]
 *        (loads DATABASE_URL from .dev-context automatically)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
  console.log('⚠️  No .dev-context found, using DATABASE_URL from environment');
}

// Dynamic imports AFTER setting DATABASE_URL so Prisma uses the right connection
const { getGitProvider } = await import('@classmoji/services');
const { default: prisma } = await import('@classmoji/database');

async function main() {
  const shouldDelete = process.argv.includes('--delete');

  console.log('🔍 Fetching classrooms, project teams, and their expected team names...\n');

  // Get all classrooms with their git organizations
  const classrooms = await prisma.classroom.findMany({
    include: {
      git_organization: true,
    },
  });

  // Get all project teams from database (these should NEVER be deleted)
  const projectTeams = await prisma.team.findMany({
    include: {
      classroom: {
        include: {
          git_organization: true,
        },
      },
    },
  });

  // Group by git org
  const classroomsByOrg = {};
  for (const classroom of classrooms) {
    const orgLogin = classroom.git_organization.login;
    if (!classroomsByOrg[orgLogin]) {
      classroomsByOrg[orgLogin] = {
        gitOrg: classroom.git_organization,
        classrooms: [],
        expectedTeams: new Set(),
        projectTeams: new Set(),
      };
    }
    classroomsByOrg[orgLogin].classrooms.push(classroom);
    // Expected teams with new slug-based naming
    classroomsByOrg[orgLogin].expectedTeams.add(`${classroom.slug}-students`);
    classroomsByOrg[orgLogin].expectedTeams.add(`${classroom.slug}-assistants`);
  }

  // Add project teams to their respective orgs (these are protected)
  for (const team of projectTeams) {
    const orgLogin = team.classroom?.git_organization?.login;
    if (orgLogin && classroomsByOrg[orgLogin]) {
      classroomsByOrg[orgLogin].projectTeams.add(team.slug);
    }
  }

  // Process each org
  for (const [orgLogin, data] of Object.entries(classroomsByOrg)) {
    console.log(`\n📦 Organization: ${orgLogin}`);
    console.log(`   Classrooms: ${data.classrooms.length}`);
    console.log(`   Expected classroom teams: ${data.expectedTeams.size}`);
    console.log(`   Protected project teams: ${data.projectTeams.size}`);

    // List expected teams
    console.log('\n   ✅ Expected classroom teams (based on classroom slugs):');
    for (const team of data.expectedTeams) {
      console.log(`      - ${team}`);
    }

    if (data.projectTeams.size > 0) {
      console.log('\n   🔒 Protected project teams (from database):');
      for (const team of data.projectTeams) {
        console.log(`      - ${team}`);
      }
    }

    try {
      const gitProvider = getGitProvider(data.gitOrg);
      const teams = await gitProvider.getTeams(orgLogin);

      console.log(`\n   📋 Actual GitHub teams: ${teams.length}`);

      const orphanedTeams = [];
      const validTeams = [];
      const protectedTeams = [];

      for (const team of teams) {
        if (data.expectedTeams.has(team.slug)) {
          validTeams.push(team);
        } else if (data.projectTeams.has(team.slug)) {
          protectedTeams.push(team);
        } else {
          orphanedTeams.push(team);
        }
      }

      if (validTeams.length > 0) {
        console.log('\n   ✅ Valid classroom teams (in use):');
        for (const team of validTeams) {
          console.log(`      - ${team.slug} (id: ${team.id})`);
        }
      }

      if (protectedTeams.length > 0) {
        console.log('\n   🔒 Protected project teams (will NOT be deleted):');
        for (const team of protectedTeams) {
          console.log(`      - ${team.slug} (id: ${team.id})`);
        }
      }

      if (orphanedTeams.length > 0) {
        console.log('\n   ⚠️  Orphaned teams (candidates for deletion):');
        for (const team of orphanedTeams) {
          console.log(`      - ${team.slug} (id: ${team.id})`);
        }

        if (shouldDelete) {
          console.log('\n   🗑️  Deleting orphaned teams...');
          for (const team of orphanedTeams) {
            try {
              await gitProvider.deleteTeam(orgLogin, team.slug);
              console.log(`      ✓ Deleted: ${team.slug}`);
            } catch (error) {
              console.error(`      ✗ Failed to delete ${team.slug}: ${error.message}`);
            }
          }
        } else {
          console.log('\n   ℹ️  Run with --delete flag to remove orphaned teams');
        }
      } else {
        console.log('\n   ✨ No orphaned teams found!');
      }

    } catch (error) {
      console.error(`   ❌ Error fetching teams: ${error.message}`);
    }
  }

  console.log('\n✅ Done!\n');
  await prisma.$disconnect();
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
