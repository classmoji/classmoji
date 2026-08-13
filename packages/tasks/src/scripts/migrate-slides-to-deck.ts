/**
 * Migrate Reveal.js slide decks to deck.json (content-tools plan §4/§9).
 *
 * For every Slide row, parses the existing `index.html` with the canonical
 * `parseDeckHtml` engine and writes ONLY `deck.json` — `index.html` is never
 * touched. This is deliberate: a batch migration must carry zero
 * visual-regression risk, so the live/CDN-served artifact is left exactly as
 * it is. `index.html` only gets regenerated the next time a real edit goes
 * through the web editor or MCP `deck_apply` (slideContent.service.saveDeck's
 * dual-write).
 *
 * Default mode is a DRY RUN: walks every matching slide and reports what
 * would happen without writing anything. The dry-run inventory of
 * DECK_PARSE_FAILED slides doubles as the plan's §9 parse census. Pass
 * --write to actually commit deck.json files.
 *
 * Writes are strictly CREATE-ONLY: absence is re-verified immediately before
 * each write and the commit goes through ContentService.put's `createOnly`
 * mode (no sha sent — GitHub 422s if the file exists, surfaced as a 409).
 * A deck.json that materializes concurrently (editor save, MCP deck_apply,
 * a parallel migration run) always wins; the migration skips, never overwrites.
 *
 * Usage:
 *   npx tsx packages/tasks/src/scripts/migrate-slides-to-deck.ts                          # dry run, all slides
 *   npx tsx packages/tasks/src/scripts/migrate-slides-to-deck.ts --write                  # apply
 *   npx tsx packages/tasks/src/scripts/migrate-slides-to-deck.ts --classroom acme/cs101   # filter to one classroom (org login/classroom slug)
 *   npx tsx packages/tasks/src/scripts/migrate-slides-to-deck.ts --limit 25               # cap the number of slides walked
 *   npx tsx packages/tasks/src/scripts/migrate-slides-to-deck.ts --write --classroom acme/cs101 --limit 5
 *
 * DATABASE_URL comes from the environment exactly like every other script in
 * this repo (see .dev-context) — this script does not select an environment
 * for you. Double- and triple-check DATABASE_URL before ever passing --write.
 */

import getPrisma from '@classmoji/database';
import { ContentService } from '@classmoji/services';
import { DeckParseError, parseDeckHtml } from '@classmoji/services/slides';

// Small inter-item pause so a large classroom doesn't hammer the GitHub API —
// mirrors the rate-limit-friendliness idiom used elsewhere in this repo for
// sequential per-item GitHub operations (e.g. slidesComImporter.server.ts).
const DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ClassroomFilter {
  orgLogin: string;
  classroomSlug: string;
}

interface CliOptions {
  write: boolean;
  classroomFilter?: ClassroomFilter;
  limit?: number;
  help: boolean;
}

function printUsage(): void {
  console.log(`
Usage: npx tsx packages/tasks/src/scripts/migrate-slides-to-deck.ts [options]

Options:
  --write                 Apply the migration (default: dry run, no writes)
  --classroom <org/slug>  Only migrate slides in this classroom (git org login / classroom slug)
  --limit <n>             Only walk the first n matching slides
  --help, -h              Show this message
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { write: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--write':
        options.write = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--classroom': {
        const value = argv[++i];
        if (!value || !value.includes('/')) {
          throw new Error(
            `--classroom expects "<org-login>/<classroom-slug>", got: ${value ?? '(missing)'}`
          );
        }
        const slashIndex = value.indexOf('/');
        const orgLogin = value.slice(0, slashIndex);
        const classroomSlug = value.slice(slashIndex + 1);
        if (!orgLogin || !classroomSlug) {
          throw new Error(`--classroom expects "<org-login>/<classroom-slug>", got: ${value}`);
        }
        options.classroomFilter = { orgLogin, classroomSlug };
        break;
      }
      case '--limit': {
        const value = argv[++i];
        const parsed = Number(value);
        if (!value || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--limit expects a positive integer, got: ${value ?? '(missing)'}`);
        }
        options.limit = parsed;
        break;
      }
      default:
        throw new Error(`Unrecognized argument: ${arg} (use --help for usage)`);
    }
  }

  return options;
}

interface ParseFailure {
  slideId: string;
  title: string;
  classroom: string;
  error: string;
  warnings: string[];
}

interface Counts {
  total: number;
  migrated: number;
  alreadyMigrated: number;
  noHtml: number;
  parseFailed: number;
  noRepo: number;
  errors: number;
}

async function migrateSlidesToDeck(options: CliOptions): Promise<void> {
  const prisma = getPrisma();

  const where = options.classroomFilter
    ? {
        classroom: {
          slug: options.classroomFilter.classroomSlug,
          git_organization: { login: options.classroomFilter.orgLogin },
        },
      }
    : undefined;

  const slides = await prisma.slide.findMany({
    where,
    include: {
      classroom: {
        include: {
          git_organization: true,
        },
      },
    },
    orderBy: { created_at: 'asc' },
    ...(options.limit != null ? { take: options.limit } : {}),
  });

  console.log(
    options.write
      ? '✍️  WRITE MODE — deck.json will be committed for every parseable slide'
      : '🔍 DRY RUN — no writes will be made (pass --write to apply)'
  );
  if (options.classroomFilter) {
    console.log(
      `🎯 Filtering to classroom ${options.classroomFilter.orgLogin}/${options.classroomFilter.classroomSlug}`
    );
  }
  if (options.limit != null) {
    console.log(`⛔ Limit: ${options.limit} slide(s)`);
  }
  console.log(`\n📦 Found ${slides.length} slide row(s) to walk\n`);

  const counts: Counts = {
    total: slides.length,
    migrated: 0,
    alreadyMigrated: 0,
    noHtml: 0,
    parseFailed: 0,
    noRepo: 0,
    errors: 0,
  };
  const failures: ParseFailure[] = [];

  for (const slide of slides) {
    const classroom = slide.classroom;
    const classroomLabel = classroom
      ? `${classroom.git_organization?.login ?? '?'}/${classroom.slug}`
      : '(no classroom)';
    const label = `${classroomLabel} :: ${slide.slug} (${slide.id})`;

    try {
      const gitOrganization = classroom?.git_organization;
      const repo = classroom?.content_repo;
      if (!classroom || !gitOrganization?.login || !repo) {
        console.log(`⚠️  Skipping ${label} — classroom missing git organization or content repo`);
        counts.noRepo++;
        continue;
      }

      const deckPath = `${slide.content_path}/deck.json`;
      const htmlPath = `${slide.content_path}/index.html`;

      const deckAlreadyExists = await ContentService.exists({
        gitOrganization,
        repo,
        path: deckPath,
      });
      if (deckAlreadyExists) {
        console.log(`⏭️  Skipping ${label} — deck.json already exists`);
        counts.alreadyMigrated++;
        continue;
      }

      const htmlFile = await ContentService.getContent({
        gitOrganization,
        repo,
        path: htmlPath,
      });
      if (!htmlFile) {
        console.log(`❌ Skipping ${label} — no index.html found at ${repo}/${htmlPath}`);
        counts.noHtml++;
        continue;
      }

      let deckResult: ReturnType<typeof parseDeckHtml>;
      try {
        deckResult = parseDeckHtml(htmlFile.content);
      } catch (parseError: unknown) {
        if (parseError instanceof DeckParseError) {
          console.log(`❌ Parse failed for ${label}: ${parseError.message}`);
          failures.push({
            slideId: slide.id,
            title: slide.title,
            classroom: classroomLabel,
            error: parseError.message,
            warnings: parseError.warnings,
          });
          counts.parseFailed++;
          continue;
        }
        throw parseError;
      }

      const { deck, warnings } = deckResult;
      if (warnings.length > 0) {
        console.log(`   ⚠️  ${warnings.length} parser warning(s) for ${label}:`);
        for (const warning of warnings) {
          console.log(`      - ${warning}`);
        }
      }

      const deckJson = JSON.stringify(deck, null, 2) + '\n';

      if (options.write) {
        // CREATE-ONLY write. The exists() probe above ran before the
        // (potentially slow) html fetch + parse; re-verify absence right
        // before writing, then commit with `createOnly` — put sends NO sha, so
        // GitHub itself rejects an existence race with a 422 (mapped to a
        // 409 by ContentService). Either path means a concurrent writer
        // (editor save, deck_apply, another migration run) materialized
        // deck.json first — their version wins and this slide is a skip,
        // never an overwrite.
        const materialized = await ContentService.exists({
          gitOrganization,
          repo,
          path: deckPath,
        });
        if (materialized) {
          console.log(`⏭️  Skipping ${label} — deck.json materialized during migration`);
          counts.alreadyMigrated++;
          continue;
        }
        try {
          await ContentService.put({
            gitOrganization,
            repo,
            path: deckPath,
            content: deckJson,
            message: 'Migrate deck to deck.json',
            createOnly: true,
          });
        } catch (writeError: unknown) {
          const status = (writeError as { status?: number }).status;
          if (status === 409) {
            console.log(`⏭️  Skipping ${label} — deck.json created concurrently (race lost)`);
            counts.alreadyMigrated++;
            continue;
          }
          throw writeError;
        }
        console.log(`✅ Migrated ${label} → ${repo}/${deckPath} (${deck.slides.length} slides)`);
      } else {
        console.log(
          `📝 [dry-run] Would migrate ${label} → ${repo}/${deckPath} (${deck.slides.length} slides)`
        );
      }
      counts.migrated++;
    } catch (err: unknown) {
      console.error(
        `❌ Error processing ${label}:`,
        err instanceof Error ? err.message : String(err)
      );
      counts.errors++;
    }

    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n📊 ${options.write ? 'Migration' : 'Dry-run'} Summary:`);
  console.log(`   📋 Total slide rows walked: ${counts.total}`);
  console.log(`   ${options.write ? '✅ Migrated' : '📝 Would migrate'}: ${counts.migrated}`);
  console.log(`   ⏭️  Already migrated (deck.json exists): ${counts.alreadyMigrated}`);
  console.log(`   ❌ No index.html found: ${counts.noHtml}`);
  console.log(`   ❌ Parse failed (DECK_PARSE_FAILED): ${counts.parseFailed}`);
  console.log(`   ⚠️  Skipped (no git org / content namespace): ${counts.noRepo}`);
  console.log(`   💥 Unexpected errors: ${counts.errors}`);

  if (failures.length > 0) {
    console.log(`\n🩹 Parse-failure inventory (plan §9 census):`);
    for (const failure of failures) {
      console.log(`\n   - Slide: ${failure.title} (${failure.slideId})`);
      console.log(`     Classroom: ${failure.classroom}`);
      console.log(`     Error: ${failure.error}`);
      if (failure.warnings.length > 0) {
        console.log(`     Warnings:`);
        for (const warning of failure.warnings) {
          console.log(`       - ${warning}`);
        }
      }
    }
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  await migrateSlidesToDeck(options);
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exitCode = 1;
});
