import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Build mapping from old token_transaction ID -> new UUID
async function buildTokenTransactionMap(userMap) {
  const tokenTxJson = readFileSync(join(__dirname, 'data/token_transactions.json'), 'utf-8');
  const oldTokenTxs = JSON.parse(tokenTxJson);

  // Load all token_transactions from DB
  const dbTokenTxs = await prisma.tokenTransaction.findMany({
    select: { id: true, student_id: true, amount: true, created_at: true },
  });

  // Key: student_id|amount|created_at (truncated to seconds)
  const makeKey = (studentId, amount, createdAt) => {
    const date = new Date(createdAt);
    return `${studentId}|${amount}|${date.toISOString().slice(0, 19)}`;
  };

  const dbTxByKey = new Map();
  for (const tx of dbTokenTxs) {
    dbTxByKey.set(makeKey(tx.student_id, tx.amount, tx.created_at), tx.id);
  }

  const tokenTxMap = new Map();
  for (const oldTx of oldTokenTxs) {
    const newStudentId = userMap.get(String(oldTx.student_id));
    if (!newStudentId) continue;

    const key = makeKey(newStudentId, oldTx.amount, oldTx.created_at);
    const newUuid = dbTxByKey.get(key);
    if (newUuid) {
      tokenTxMap.set(oldTx.id, newUuid);
    }
  }

  console.log(`Built token_transaction map: ${tokenTxMap.size} of ${oldTokenTxs.length} entries`);
  return tokenTxMap;
}

async function main() {
  // Load users to map old GitHub ID -> new UUID
  const users = await prisma.user.findMany({ select: { id: true, provider_id: true } });
  const userMap = new Map(users.map((u) => [u.provider_id, u.id]));
  console.log(`Loaded ${userMap.size} users for mapping`);

  // Build token transaction mapping
  const tokenTxMap = await buildTokenTransactionMap(userMap);

  // Read issue_grades from JSON
  const gradesJson = readFileSync(join(__dirname, 'data/issue_grades.json'), 'utf-8');
  const issueGrades = JSON.parse(gradesJson);

  console.log(`Migrating ${issueGrades.length} issue_grades -> assignment_grades...`);

  let migrated = 0;
  let skipped = 0;

  for (const g of issueGrades) {
    try {
      // Find RepositoryAssignment by provider_id (old issue_id)
      const repoAssignment = await prisma.repositoryAssignment.findFirst({
        where: { provider_id: String(g.issue_id) },
      });

      if (!repoAssignment) {
        console.log(`⊘ Skipping: repository_assignment ${g.issue_id} not found`);
        skipped++;
        continue;
      }

      // Find grader by provider_id (old grader_id is GitHub user ID)
      let graderId = null;
      if (g.grader_id) {
        const grader = await prisma.user.findFirst({
          where: { provider_id: String(g.grader_id) },
        });
        if (grader) {
          graderId = grader.id;
        }
      }

      // Look up token_transaction UUID from map
      let tokenTransactionId = null;
      if (g.token_transaction_id) {
        tokenTransactionId = tokenTxMap.get(g.token_transaction_id) || null;
      }

      // Create AssignmentGrade
      await prisma.assignmentGrade.create({
        data: {
          repository_assignment_id: repoAssignment.id,
          grader_id: graderId,
          emoji: g.grade,
          token_transaction_id: tokenTransactionId,
          created_at: new Date(g.created_at),
          updated_at: new Date(g.updated_at),
        },
      });

      migrated++;
      if (migrated % 100 === 0) {
        console.log(`✓ Migrated ${migrated} grades...`);
      }
    } catch (error) {
      if (error.code === 'P2002') {
        skipped++;
      } else {
        console.error(`✗ Failed: grade ${g.id}`, error.message);
        skipped++;
      }
    }
  }

  console.log(`\nMigration complete! Migrated: ${migrated}, Skipped: ${skipped}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
