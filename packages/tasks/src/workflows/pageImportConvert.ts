import { logger, schemaTask } from '@trigger.dev/sdk';
import { htmlToPageBlocks } from '@classmoji/page-schema/html';
import { processMarkdownImport, wrapHtmlContent } from '@classmoji/services/markdown-importer';
import {
  PAGE_IMPORT_CONVERT_TASK_ID,
  PAGE_IMPORT_OUTPUT_MAX_BYTES,
  parsePageImportPayload,
  serializedBytes,
  type PageImportOutput,
  type PageImportPayload,
} from '@classmoji/services/page-import-contract';

/**
 * `page-import-convert` — the text conversion of a page create, and nothing
 * else: markdown -> HTML (`processMarkdownImport`: marked, prettier on code
 * fences) -> the import's document (`wrapHtmlContent`, width 2) -> page blocks
 * (`htmlToPageBlocks`), or HTML -> page blocks for MCP `page_create`'s `html`.
 *
 * Here because the converter needs jsdom and BlockNote's server editor, and the
 * markdown step prettier's Node build, none of which the web app or the MCP
 * server may load. Triggered by string id from `ClassmojiService.pageImport`
 * (`packages/services/src/classmoji/pageImport.service.ts`), which waits for
 * the output; the files, the commit, the page row and the audit row stay with
 * the caller.
 *
 * No database, no Git, no network, no secrets: the payload is text plus the
 * uploads' NAMES (never their bytes), and the output is the blocks plus where
 * each matched upload goes, so the caller commits it there. The same input
 * gives the same blocks as the in-process pipeline it replaced, except for
 * the block ids (random) and the image file names' timestamp.
 *
 * Not in `src/index.ts` (Trigger finds it through `dirs`): importing it there
 * would pull the converter into every app that imports `@classmoji/tasks`.
 */

/** The run, called directly by the tests. */
export async function runPageImportConvert(payload: PageImportPayload): Promise<PageImportOutput> {
  const titleOption = payload.title ? { title: payload.title } : {};
  let output: PageImportOutput;

  if (payload.kind === 'html') {
    output = { ok: true, blocks: await htmlToPageBlocks(payload.html, titleOption) };
  } else {
    const uploads = payload.images.map((name, index) => ({ name, index }));
    const { html, imageMap, unmatchedImages, missingImages } = await processMarkdownImport(
      payload.markdown,
      uploads,
      payload.options
    );
    const blocks = await htmlToPageBlocks(wrapHtmlContent(html, 2), titleOption);
    output = {
      ok: true,
      blocks,
      images: [...imageMap.entries()].map(([originalPath, info]) => ({
        originalPath,
        index: (info.file as { index: number }).index,
        newPath: info.newPath as string,
        newFilename: info.newFilename as string,
        githubUrl: info.githubUrl as string,
      })),
      unmatched: unmatchedImages.map(upload => upload.index),
      missing: missingImages,
    };
  }

  // Trigger.dev refuses an output over 10 MB, and the caller would only see
  // the run fail: answered here instead, so the person reads why.
  if (serializedBytes(output) > PAGE_IMPORT_OUTPUT_MAX_BYTES) {
    return { ok: false, code: 'too_large' };
  }
  return output;
}

export const pageImportConvert = schemaTask({
  id: PAGE_IMPORT_CONVERT_TASK_ID,
  schema: parsePageImportPayload,
  // Someone is waiting on the answer (up to 45 s); a run past that is wasted.
  maxDuration: 60,
  // Deterministic: a second attempt would fail the same way, after the caller
  // stopped waiting.
  retry: { maxAttempts: 1 },
  // jsdom and BlockNote's server editor hold the whole document: a page at
  // the markdown cap peaks near 1 GB, the default small-2x's whole memory.
  // Not medium-1x: that preset is content-checkpoint's own, so its kept-alive
  // process stays its own (see processKeepAlive in trigger.config.js).
  machine: 'medium-2x',
  run: async (payload: PageImportPayload) => {
    const started = Date.now();
    const result = await runPageImportConvert(payload);
    // Sizes and timing only: never the text.
    logger.info('page-import-convert', {
      kind: payload.kind,
      chars: payload.kind === 'html' ? payload.html.length : payload.markdown.length,
      images: payload.kind === 'markdown' ? payload.images.length : 0,
      ok: result.ok,
      blocks: result.ok ? result.blocks.length : 0,
      ms: Date.now() - started,
    });
    return result;
  },
});
