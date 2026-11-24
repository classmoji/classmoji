/**
 * Run by `serverNoJsdom.test.ts` in a child `node` process (not under
 * vitest, whose own resolver would hide what Node loads):
 *
 *   node noDomChild.ts <entry>
 *
 * Refuses to resolve `jsdom` and `@blocknote/server-util` (any import or
 * require, from any module, first-party or in node_modules), records every
 * module Node resolves, imports `<entry>` (a path), then seeds the
 * kitchen-sink fixture into a Y.Doc, ships it as an encoded update to a new
 * doc and reads it back. Prints one JSON line: what was blocked, any resolved
 * URL that names jsdom or server-util, the globals, and the blocks read back.
 * Exits 1 when anything was blocked or the round trip throws.
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const BLOCKED = /^(jsdom|@blocknote\/server-util)(\/|$)/;
const NAMED = /\/node_modules\/(jsdom|@blocknote\/server-util)\//;

const blocked: string[] = [];
const resolvedNamed: string[] = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (BLOCKED.test(specifier)) {
      blocked.push(`${specifier} (from ${context.parentURL ?? '?'})`);
      throw new Error(`[noDomChild] refused to resolve ${specifier}`);
    }
    const result = nextResolve(specifier, context);
    if (NAMED.test(result.url)) resolvedNamed.push(result.url);
    return result;
  },
});

const entry = process.argv[2];
if (!entry) throw new Error('usage: node noDomChild.ts <entry>');

let error: string | null = null;
let blocks: unknown = null;
try {
  const server = (await import(pathToFileURL(entry).href)) as typeof import('../../server.ts');
  const Y = await import('yjs');
  const fixture = JSON.parse(
    readFileSync(new URL('./kitchen-sink.content.json', import.meta.url), 'utf8')
  ) as { blocks: unknown[]; coverImage?: { url: string; position: number } | null };
  const seeded = server.pageContentToYDoc({
    blocks: fixture.blocks,
    coverImage: fixture.coverImage ?? null,
  });
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(seeded));
  blocks = server.yDocToPageContent(loaded).blocks;
  // The accessor collab uses; touching it must not need a DOM either.
  if (!('blockContainer' in server.pmSchema().nodes)) throw new Error('no blockContainer node');
} catch (err) {
  error = err instanceof Error ? (err.stack ?? err.message) : String(err);
}

process.stdout.write(
  JSON.stringify({
    blocked,
    resolvedNamed,
    error,
    windowType: typeof (globalThis as { window?: unknown }).window,
    documentType: typeof (globalThis as { document?: unknown }).document,
    blocks,
  }) + '\n'
);
process.exitCode = error || blocked.length || resolvedNamed.length ? 1 : 0;
