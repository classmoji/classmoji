/**
 * The MDX extractor's CONTRACT, pinned against real documentation pages.
 *
 * ── Why real pages and not hand-written snippets ───────────────────────────
 * Every bug this extractor can have is a bug about a shape that actually occurs
 * in `apps/site/src/content/docs`, and a snippet written by the same person who
 * wrote the stripper tests only what they already thought of. The fixtures
 * under `fixtures/docs/` are eight of the twenty-five pages, copied byte for
 * byte from the public repo this indexes.
 *
 * ── EXACT PRESERVATION, not a length guard ─────────────────────────────────
 * A blanket `expect(text.length).toBeGreaterThan(…)` passes for a stripper that
 * has quietly turned `TRIGGER_SECRET_KEY` into `TRIGGERSECRETKEY`. Every
 * assertion below names the exact string that must survive, or the exact string
 * that must NOT appear, because those are the failures that reach a user as
 * confident, wrong configuration advice.
 *
 * ── The live corpus sweep ──────────────────────────────────────────────────
 * The last block runs the extractor over EVERY `.mdx` in the real docs tree
 * when that tree is present. That is what catches the docs growing a ninth
 * component, a block-scalar frontmatter or a paired tag — the cases the
 * extractor refuses on purpose, which must surface as a failing test here
 * rather than as a page that silently stops being searchable.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractMdxText, KNOWN_MDX_COMPONENTS, MDX_EXTRACT_VERSION } from '../mdx.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'docs');

const page = (relative: string): string => readFileSync(join(FIXTURES, relative), 'utf8');
const textOf = (relative: string): string => {
  const result = extractMdxText(page(relative));
  expect(result.ok, `${relative} must extract`).toBe(true);
  return result.text;
};

/** Every fixture's text, for the assertions that must hold across all of them. */
const ALL_FIXTURES = [
  'index.mdx',
  'video-tutorials.mdx',
  'instructors/roster.mdx',
  'instructors/mcp-server.mdx',
  'instructors/grading.mdx',
  'instructors/custom-domains.mdx',
  'self-hosting/environment-variables.mdx',
  'open-source/local-development/index.mdx',
] as const;

describe('code survives verbatim, because it is protected before anything else runs', () => {
  it('keeps an underscored env var out of a fenced block intact', () => {
    // `TRIGGER_SECRET_KEY="tr_dev_your-key-here"` lives inside a fenced env
    // block. An emphasis pass that ran before code was protected would eat both
    // underscores and index `TRIGGERSECRETKEY`.
    expect(textOf('open-source/local-development/index.mdx')).toContain(
      'TRIGGER_SECRET_KEY="tr_dev_your-key-here"'
    );
  });

  it('keeps an underscored identifier out of an INLINE code span intact', () => {
    // `context_servers` appears twice in mcp-server.mdx: once as an inline span
    // in prose and once inside a json fence. Both must survive.
    const text = textOf('instructors/mcp-server.mdx');
    expect(text).toContain('context_servers');
    expect(text).not.toContain('contextservers');
    expect(text).toContain('"context_servers": {');
  });

  it('keeps a leading-underscore DNS record name intact', () => {
    // `_acme-challenge.{your domain}` is an inline span inside a table cell —
    // two rules at once, either of which could mangle it.
    const text = textOf('instructors/custom-domains.mdx');
    expect(text).toContain('_acme-challenge');
    expect(text).toContain('_fly-ownership');
  });

  it('keeps a whole shell command copyable', () => {
    expect(textOf('instructors/mcp-server.mdx')).toContain(
      'claude mcp add --transport http classmoji https://mcp.classmoji.io/mcp'
    );
  });

  it('keeps an env-var name inside a table cell intact', () => {
    expect(textOf('self-hosting/environment-variables.mdx')).toContain('TRIGGER_SECRET_KEY');
  });

  it('leaves the `{variable}` placeholders in code alone rather than reading them as JSX', () => {
    expect(textOf('instructors/custom-domains.mdx')).toContain('{your domain}');
  });
});

describe('a screenshot is attributed AND keeps its caption', () => {
  const roster = () => textOf('instructors/roster.mdx');

  it('harvests the alt text, labelled with the component it came from', () => {
    expect(roster()).toContain(
      'Screenshot: A teaching staff list showing a TA with a grader-role toggle and status'
    );
  });

  it('keeps the caption that contradicts the alt, on the line after it', () => {
    // THE case finding 2 is about. The alt describes a grader-role toggle; the
    // caption says the screenshot is out of date. An index that carried the
    // first without the second would answer "there is a grader-role toggle on
    // the Teaching Staff list" as current product behaviour.
    expect(roster()).toMatch(
      /Screenshot: A teaching staff list showing a TA with a grader-role toggle and status\nAn earlier version of this screen, from when it listed assistants only\./
    );
  });

  it('leaves the prose around the component exactly where it was', () => {
    const text = roster();
    const preceding =
      'Roles add up rather than replace: granting someone a second role in the same class leaves the first one alone, and they appear once per role they hold.';
    const following = 'Removing someone';
    expect(text).toContain(preceding);
    expect(text.indexOf(preceding)).toBeLessThan(text.indexOf('Screenshot: A teaching staff list'));
    expect(text.indexOf('Screenshot: A teaching staff list')).toBeLessThan(text.indexOf(following));
  });

  it('NEVER harvests `url` — it is browser chrome, not a destination', () => {
    // Screenshot.astro draws it as display text in a fake browser frame, over
    // an example classroom that does not exist. Indexed, it becomes a link the
    // assistant hands a real instructor.
    expect(roster()).not.toContain('app.classmoji.io/admin/cs-101/students');
    for (const fixture of ALL_FIXTURES) {
      expect(textOf(fixture), `${fixture} must not carry a Screenshot url`).not.toContain(
        'app.classmoji.io/admin/cs-101'
      );
    }
  });

  it('harvests an alt containing a `>` WHOLE, and leaves no tag debris behind', () => {
    // `alt="Settings > Grades showing …"`. A depth-only scanner ends the tag at
    // that `>`, truncating the alt and spilling `… frame url="…" size="lg" />`
    // into the corpus as prose.
    const text = textOf('instructors/grading.mdx');
    expect(text).toContain(
      'Screenshot: Settings > Grades showing the emoji-to-value mappings and the Populate defaults button'
    );
    expect(text).not.toContain('/>');
    expect(text).not.toContain('size="lg"');
    expect(text).not.toContain('frame url=');
  });
});

describe('multiline components are consumed whole', () => {
  it('consumes every multiline <Video> in video-tutorials.mdx', () => {
    // A line-oriented scanner leaves `id="…"`, `title={…}` and `poster={…}`
    // behind as prose when the opening `<Video` is alone on its line.
    const text = textOf('video-tutorials.mdx');
    expect(text).not.toContain('<Video');
    expect(text).not.toContain('poster=');
    expect(text).not.toContain('src=');
    expect(text).not.toContain('title={');
    expect(text.match(/^Video: /gm) ?? []).toHaveLength(3);
    expect(text).toContain('Video: Getting started with Classmoji\nSet up your Classmoji account');
  });

  it('consumes the multiline <DocCards> array without emitting any href', () => {
    // Its cards are an attribute EXPRESSION — a nested JS array. Harvesting it
    // would mean evaluating an attribute and emitting navigation URLs.
    const text = textOf('index.mdx');
    expect(text).not.toContain('DocCards');
    expect(text).not.toContain('href:');
    expect(text).not.toContain('/docs/introduction/getting-started');
    // The prose after it is still there, so the block was consumed rather than
    // the rest of the file being swallowed with it.
    expect(text).toContain('What is Classmoji?');
  });
});

describe('tables are left exactly as they are', () => {
  it('keeps a row’s pipes, its cells and its EMPTY cell', () => {
    // The association between a name, whether it is required, its default and
    // its description IS the content. An empty "Default" cell means "no
    // default" — dropping it shifts every later cell under the wrong header.
    const text = textOf('self-hosting/environment-variables.mdx');
    expect(text).toContain(
      '| TRIGGER_SECRET_KEY | No | | Trigger.dev secret key used to authenticate background job runs. |'
    );
    expect(text).toContain('| Name | Required | Default | Description |');
  });

  it('does not strip emphasis inside a table cell either', () => {
    expect(textOf('instructors/custom-domains.mdx')).toContain('| **CNAME** | _acme-challenge');
  });
});

describe('markdown syntax becomes prose', () => {
  it('drops heading hashes, bullets, emphasis and link targets', () => {
    const text = textOf('instructors/roster.mdx');
    expect(text).toContain('Adding students');
    expect(text).not.toMatch(/^#{1,6} /m);
    expect(text).toContain('Go to the Students tab and click Add Students in the top right.');
    expect(text).toContain('Assistant: grades the work assigned to them and helps run the class.');
    expect(text).not.toMatch(/^- /m);
  });

  it('keeps the prose inside a ::: directive and drops only the markers', () => {
    const text = textOf('instructors/mcp-server.mdx');
    expect(text).not.toMatch(/^:::/m);
    expect(text).toContain('The assistant acts as you, with exactly your permissions');
  });

  it('collapses a markdown link to its text, dropping the TARGET as well as the brackets', () => {
    // Not merely "the `](` syntax is gone": a stripper that rewrote
    // `[Docker](https://www.docker.com/)` to `Docker https://www.docker.com/`
    // also satisfies that, and puts a wall of URLs into the embedded text.
    const text = textOf('open-source/local-development/index.mdx');
    expect(text).not.toMatch(/\]\(https?:/);
    expect(text).toContain('Docker');
    expect(text).not.toContain('https://www.docker.com/');
    expect(text).not.toContain(
      'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/fork-a-repo'
    );
    expect(text).toContain('how to fork a repo');
  });

  it('strips emphasis ONLY at word boundaries, so an identifier in plain prose survives', () => {
    // The code-span protection does not cover this: an env var named in running
    // prose without backticks reaches the emphasis rules unprotected, and a
    // blanket `_` strip turns `AI_AGENT_URL` into `AIAGENTURL` — a name that
    // matches nothing anyone can search for.
    const result = extractMdxText(
      '---\ntitle: Test\ndescription: d\n---\n\nSet AI_AGENT_URL and *also* __both__ of _these_ to enable it.\n'
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('AI_AGENT_URL');
    expect(result.text).toContain('also');
    expect(result.text).not.toContain('*also*');
    expect(result.text).toContain('these');
    expect(result.text).not.toContain('_these_');
  });

  it('leaves an UNPAIRED asterisk alone — a glob is not emphasis', () => {
    // `*.env` has one asterisk and no closing partner. A blanket `*` strip
    // turns it into `.env`, which is a different filename.
    const result = extractMdxText(
      '---\ntitle: Test\ndescription: d\n---\n\nIgnore files matching *.env and keep **this** bold.\n'
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('*.env');
    expect(result.text).toContain('keep this bold.');
    expect(result.text).not.toContain('**this**');
  });
});

describe('no tag or import syntax reaches the corpus', () => {
  it.each(ALL_FIXTURES)('%s carries no import, component or JSX debris', fixture => {
    const text = textOf(fixture);
    expect(text).not.toMatch(/^import /m);
    expect(text).not.toContain('~/components');
    expect(text).not.toContain('.astro');
    expect(text).not.toContain('DocCards');
    expect(text).not.toContain('href:');
    for (const component of KNOWN_MDX_COMPONENTS) {
      expect(text, `${fixture} still contains <${component}`).not.toContain(`<${component}`);
    }
  });
});

describe('the title and description lead the text', () => {
  it('puts frontmatter title then description at the top', () => {
    const result = extractMdxText(page('instructors/roster.mdx'));
    expect(result.title).toBe('Manage your roster');
    expect(result.description).toBe('How to add students and teaching staff to your classroom');
    expect(result.text.startsWith('Manage your roster\nHow to add students')).toBe(true);
  });
});

describe('an unfamiliar shape is a refusal, never a guess', () => {
  const withFrontmatter = (body: string): string =>
    `---\ntitle: Test page\ndescription: A fixture\n---\n\n${body}\n`;

  it('refuses a component nobody has decided about', () => {
    const result = extractMdxText(withFrontmatter('<NewThing prop="x" />'));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown_component');
    expect(result.text).toBe('');
  });

  it('refuses a paired JSX element, whose children are an open question', () => {
    const result = extractMdxText(withFrontmatter('<Screenshot alt="x">child</Screenshot>'));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('paired_component');
  });

  it('refuses a tag that never closes', () => {
    const result = extractMdxText(withFrontmatter('<Screenshot alt="x"'));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unclosed_component');
  });

  it('refuses a page with no frontmatter at all', () => {
    const result = extractMdxText('Just some prose with no frontmatter.\n');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('frontmatter_missing');
  });

  it('refuses frontmatter with no closing delimiter', () => {
    const result = extractMdxText('---\ntitle: Test page\ndescription: A fixture\n\nBody.\n');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('frontmatter_unterminated');
  });

  it('refuses a block scalar rather than indexing its first line', () => {
    const result = extractMdxText(
      '---\ntitle: Test\ndescription: |\n  line one\n  line two\n---\n\nBody.\n'
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('frontmatter_block_scalar');
  });

  it('refuses a value continued on the next line', () => {
    const result = extractMdxText(
      '---\ntitle: Test\ndescription: starts here\n  and continues\n---\n\nBody.\n'
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('frontmatter_unparsed');
  });

  it('refuses a page with no title', () => {
    const result = extractMdxText('---\ndescription: A fixture\n---\n\nBody.\n');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('frontmatter_missing_title');
  });

  it('refuses an empty title, which is not the same as a page called ""', () => {
    const result = extractMdxText('---\ntitle:\ndescription: A fixture\n---\n\nBody.\n');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('frontmatter_missing_title');
  });

  it('refuses an import shape it has not been taught', () => {
    const result = extractMdxText(withFrontmatter("import { A, B } from '~/components/x.astro';"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown_import');
  });

  it('refuses an empty source', () => {
    expect(extractMdxText('').error).toBe('empty_source');
    expect(extractMdxText('   \n  ').error).toBe('empty_source');
  });

  it('IGNORES an unknown frontmatter key whose shape is familiar', () => {
    // Unknown keys are not a refusal — an unknown SHAPE is. A new scalar key is
    // additive; a block scalar or a nested mapping is not.
    const result = extractMdxText('---\ntitle: Test\nsidebar_order: 3\n---\n\nBody.\n');
    expect(result.ok).toBe(true);
    expect(result.title).toBe('Test');
    expect(result.text).toContain('Body.');
    expect(result.text).not.toContain('sidebar_order');
  });

  it('accepts a quoted frontmatter value, unquoted', () => {
    const result = extractMdxText(
      '---\ntitle: "Quoted title"\ndescription: \'Quoted\'\n---\n\nBody.\n'
    );
    expect(result.ok).toBe(true);
    expect(result.title).toBe('Quoted title');
    expect(result.description).toBe('Quoted');
  });

  it('is a SUCCESS, not a failure, when the body trims to nothing', () => {
    const result = extractMdxText('---\ntitle: Stub page\ndescription: Nothing yet\n---\n');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Stub page\nNothing yet');
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['---', '---\n---', '`'.repeat(9), '<', '{{{{', '---\ntitle: t\n---\n<']) {
      expect(() => extractMdxText(input)).not.toThrow();
    }
  });
});

describe('the version constant', () => {
  it('is a positive integer nothing else may redeclare', () => {
    expect(Number.isInteger(MDX_EXTRACT_VERSION)).toBe(true);
    expect(MDX_EXTRACT_VERSION).toBeGreaterThan(0);
  });
});

// ─── The live corpus ────────────────────────────────────────────────────────

/**
 * The real `apps/site/src/content/docs` tree, when this checkout has it.
 *
 * Guarded rather than assumed, the same way the ai-agent's prompt tests guard
 * their cross-package reads: a services test must not hard-fail because
 * somebody moved an app. When it IS there, this is the assertion that turns a
 * docs change the extractor refuses into a red test instead of a page that
 * quietly stops being searchable.
 */
const DOCS_ROOT = join(
  here,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'apps',
  'site',
  'src',
  'content',
  'docs'
);
const haveDocs = existsSync(DOCS_ROOT);
const describeLive = haveDocs ? describe : describe.skip;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.mdx') ? [full] : [];
  });

describeLive('every page in the live docs tree extracts', () => {
  it('extracts all of them, and names any that do not', () => {
    const files = walk(DOCS_ROOT).sort();
    expect(files.length).toBeGreaterThan(0);

    const refused = files
      .map(file => ({ file, result: extractMdxText(readFileSync(file, 'utf8')) }))
      .filter(entry => !entry.result.ok)
      .map(entry => `${entry.file.slice(DOCS_ROOT.length)}: ${entry.result.error}`);

    // A refusal here is not necessarily a bug in the extractor — it is the
    // extractor reporting that the docs grew a shape nobody decided about.
    // Either teach it the shape or change the page; do not loosen this.
    expect(refused).toEqual([]);
  });

  it('leaves no page with tag or import debris', () => {
    for (const file of walk(DOCS_ROOT)) {
      const { text } = extractMdxText(readFileSync(file, 'utf8'));
      expect(text, file).not.toMatch(/^import /m);
      expect(text, file).not.toContain('/>');
      expect(text, file).not.toContain('~/components');
    }
  });

  it('consumes all six <Video> blocks across the whole corpus', () => {
    // The plan says "video-tutorials.mdx: all six multiline <Video> blocks" —
    // that file has three. The other three live in getting-started.mdx,
    // create-classroom.mdx and import-github-classroom.mdx. Six is the CORPUS
    // total, and this is where it is checked.
    const videos = walk(DOCS_ROOT)
      .map(file => extractMdxText(readFileSync(file, 'utf8')).text)
      .join('\n')
      .match(/^Video: /gm);
    expect(videos ?? []).toHaveLength(6);
  });

  it('keeps the copied fixtures byte-identical to the live pages', () => {
    // The fixtures are the stable contract; this is what says they still
    // describe reality. A docs edit that changes one of them fails HERE, with a
    // clear instruction, rather than leaving the contract tests green against
    // text nobody serves any more.
    for (const relative of ALL_FIXTURES) {
      const live = join(DOCS_ROOT, 'docs', relative);
      if (!existsSync(live)) continue;
      expect(readFileSync(live, 'utf8'), `${relative} drifted — re-copy the fixture`).toBe(
        page(relative)
      );
    }
  });
});
