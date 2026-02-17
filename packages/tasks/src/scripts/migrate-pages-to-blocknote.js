import { PrismaClient } from '@prisma/client';
import { ContentService } from '@classmoji/content';
import { migrateHtmlToBlockNote } from '../../../../apps/pages/app/utils/migration.server.js';
import { generateTermString } from '@classmoji/utils';
import { BlockNoteSchema, defaultBlockSpecs, createCodeBlockSpec } from '@blocknote/core';
import { multiColumnSchema } from '@blocknote/xl-multi-column';
import { codeBlockOptions } from '@blocknote/code-block';
import { Callout } from '../../../../apps/pages/app/components/editor/blocks/CalloutBlock.jsx';
import { Terminal } from '../../../../apps/pages/app/components/editor/blocks/TerminalBlock.jsx';
import { Profile } from '../../../../apps/pages/app/components/editor/blocks/ProfileBlock.jsx';
import { PageLink } from '../../../../apps/pages/app/components/editor/blocks/PageLinkBlock.jsx';
import { Divider } from '../../../../apps/pages/app/components/editor/blocks/DividerBlock.jsx';
import { Embed } from '../../../../apps/pages/app/components/editor/blocks/EmbedBlock.jsx';
import { Video } from '../../../../apps/pages/app/components/editor/blocks/VideoBlock.jsx';

// Create the schema inline (same as in index.jsx but without React imports)
const { audio, video: defaultVideo, ...filteredDefaultBlockSpecs } = defaultBlockSpecs;

const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...filteredDefaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    ...multiColumnSchema.blockSpecs,
    callout: Callout(),
    terminal: Terminal(),
    profile: Profile(),
    pageLink: PageLink(),
    divider: Divider(),
    embed: Embed(),
    video: Video(),
  },
});

async function migratePagesToBlockNote() {
  const prisma = new PrismaClient();

  try {
    // First, check total page count
    const totalCount = await prisma.page.count();
    console.log(`📊 Total pages in database: ${totalCount}`);

    // Fetch all pages with classroom and git org data
    const pages = await prisma.page.findMany({
      include: {
        classroom: {
          include: {
            git_organization: true
          }
        }
      }
    });

    console.log(`📦 Fetched ${pages.length} pages with classroom/git org data`);

    // Check for pages without classroom
    const pagesWithoutClassroom = pages.filter(p => !p.classroom);
    if (pagesWithoutClassroom.length > 0) {
      console.log(`⚠️  ${pagesWithoutClassroom.length} pages missing classroom relationship`);
    }

    // Check for pages without git org
    const pagesWithoutGitOrg = pages.filter(p => p.classroom && !p.classroom.git_organization);
    if (pagesWithoutGitOrg.length > 0) {
      console.log(`⚠️  ${pagesWithoutGitOrg.length} pages missing git organization`);
    }

    // Show unique git organizations found
    const gitOrgs = new Set();
    pages.forEach(p => {
      if (p.classroom?.git_organization) {
        gitOrgs.add(p.classroom.git_organization.login);
      }
    });
    console.log(`\n🏢 Git Organizations found: ${Array.from(gitOrgs).join(', ')}`);

    // OPTIONAL: Override git organization via environment variable
    // Set OVERRIDE_GIT_ORG_LOGIN to use a different git org than what's in the database
    const OVERRIDE_GIT_ORG_LOGIN = process.env.OVERRIDE_GIT_ORG_LOGIN;
    if (OVERRIDE_GIT_ORG_LOGIN) {
      console.log(`\n⚠️  Git org override enabled: Will use "${OVERRIDE_GIT_ORG_LOGIN}" for all pages`);
    }

    // OPTIONAL: Filter to specific git org (uncomment and set the org name)
    // const TARGET_GIT_ORG = 'classmoji-development';
    // const filteredPages = pages.filter(p => p.classroom?.git_organization?.login === TARGET_GIT_ORG);
    // console.log(`🎯 Filtering to ${TARGET_GIT_ORG}: ${filteredPages.length} pages`);
    // const pagesToProcess = filteredPages;

    const pagesToProcess = pages;

    let converted = 0;
    let skipped = 0;
    let errors = 0;

    console.log(`\n📝 Processing ${pagesToProcess.length} pages...\n`);

    for (const page of pagesToProcess) {
      try {
        // Skip pages without required relationships
        if (!page.classroom) {
          console.log(`⚠️  Skipping ${page.slug} - no classroom relationship`);
          errors++;
          continue;
        }

        if (!page.classroom.git_organization) {
          console.log(`⚠️  Skipping ${page.slug} - no git organization`);
          errors++;
          continue;
        }

        const gitOrg = page.classroom.git_organization;

        // Apply git org override if set
        const effectiveGitOrg = OVERRIDE_GIT_ORG_LOGIN
          ? { ...gitOrg, login: OVERRIDE_GIT_ORG_LOGIN }
          : gitOrg;

        const term = generateTermString(page.classroom.term, page.classroom.year);
        const repo = `content-${effectiveGitOrg.login}-${term}`;

        console.log(`\n🔍 Processing: ${page.slug}`);
        console.log(`   Git Org: ${gitOrg.login} ${OVERRIDE_GIT_ORG_LOGIN ? `→ ${effectiveGitOrg.login} (overridden)` : ''}`);
        console.log(`   Term: ${page.classroom.term}, Year: ${page.classroom.year}`);
        console.log(`   Generated term string: ${term}`);
        console.log(`   Repo: ${repo}`);
        console.log(`   Path: ${page.content_path}`);

        // Check if content.json already exists
        try {
          await ContentService.getContent({
            gitOrganization: effectiveGitOrg,
            repo,
            path: `${page.content_path}/content.json`
          });

          console.log(`⏭️  Skipping ${page.slug} - content.json already exists`);
          skipped++;
          continue;
        } catch (err) {
          // content.json doesn't exist, proceed with migration
          console.log(`   No content.json found, checking for index.html...`);
        }

        // Load index.html
        let htmlContent;
        try {
          const htmlResult = await ContentService.getContent({
            gitOrganization: effectiveGitOrg,
            repo,
            path: `${page.content_path}/index.html`
          });
          htmlContent = htmlResult.content;
          console.log(`   ✓ Found index.html (${htmlContent.length} bytes)`);
        } catch (err) {
          console.log(`❌ No index.html found for ${page.slug}: ${err.message}`);
          errors++;
          continue;
        }

        // Convert to BlockNote JSON
        const blockNoteContent = await migrateHtmlToBlockNote(htmlContent, schema);

        // Save as content.json to GitHub
        await ContentService.put({
          gitOrganization: effectiveGitOrg,
          repo,
          path: `${page.content_path}/content.json`,
          content: JSON.stringify(blockNoteContent, null, 2),
          message: `Migrate ${page.slug} from HTML to BlockNote format`
        });

        console.log(`✅ Converted ${page.slug}`);
        converted++;

      } catch (err) {
        console.error(`❌ Error converting ${page.slug}:`, err.message);
        errors++;
      }
    }

    console.log(`\n📊 Migration Summary:`);
    console.log(`   ✅ Converted: ${converted}`);
    console.log(`   ⏭️  Skipped (already migrated): ${skipped}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`   📋 Total: ${pages.length}`);

  } finally {
    await prisma.$disconnect();
  }
}

// Run the migration
migratePagesToBlockNote()
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
