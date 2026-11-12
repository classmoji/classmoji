/**
 * A page save is counted before it is parsed: its ops (an ops save) or its
 * document (a whole-document save), each at most `DOCUMENT_SAVE_MAX_BYTES`.
 *
 * `readSaveOps` is what the page action reads an ops save with; it is tested
 * here directly. The action itself needs Postgres and a content repo, so what
 * it does with the answer, and the order of the whole-document check, are
 * pinned from source (as `upload-body-gate.spec.ts` does).
 * Runs in the Playwright runner without a browser or the dev stack.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { ClassmojiService } from '@classmoji/services';
import { DOCUMENT_SAVE_MAX_BYTES } from '@classmoji/utils/repo-limits';
import { textOverBytes } from '@classmoji/utils/upload-limit';
import { OPS_MALFORMED_ANSWER, readSaveOps } from '../../app/utils/saveOps.server.ts';
import { isCodeFallbackRefusal } from '../../app/routes/$classroomSlug.$pageId/saveState.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const ACTION_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
const EDITOR_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.tsx');
const KITCHEN_SINK = JSON.parse(
  source('../../../../packages/page-schema/src/__tests__/fixtures/kitchen-sink.content.json')
) as { blocks: Record<string, unknown>[] };

const schema = ClassmojiService.pageContent.pageBlockOpsPayloadSchema;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The largest page.content.json measured in real course content (2026-11-11). */
const LARGEST_REAL_PAGE_BYTES = 65_572;

/** Kitchen-sink blocks, repeated with fresh ids until the JSON is at least `min` bytes. */
function pageOfAtLeast(min: number): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  let copy = 0;
  while (bytes(JSON.stringify(blocks)) < min) {
    copy += 1;
    const text = JSON.stringify(KITCHEN_SINK.blocks).replace(
      /"id":"([^"]+)"/g,
      (_, id: string) => `"id":"${id}-${copy}"`
    );
    blocks.push(...(JSON.parse(text) as Record<string, unknown>[]));
  }
  return blocks;
}

/** One op, as JSON text of exactly `size` bytes. */
function opsTextOf(size: number): string {
  const shell = JSON.stringify([{ op: 'delete', id: '' }]);
  return JSON.stringify([{ op: 'delete', id: 'x'.repeat(size - bytes(shell)) }]);
}

/** Count JSON.parse calls made while `run` runs. */
function countingParses<T>(run: () => T): { result: T; parses: number } {
  const real = JSON.parse;
  let parses = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parses += 1;
    return real(...args);
  }) as typeof JSON.parse;
  try {
    return { result: run(), parses };
  } finally {
    JSON.parse = real;
  }
}

test.describe('an ops save is counted before it is parsed', () => {
  test('ops over the save cap are refused without being parsed or checked', () => {
    let checks = 0;
    const watching = {
      safeParse: (value: unknown) => {
        checks += 1;
        return schema.safeParse(value);
      },
    };
    const over = opsTextOf(DOCUMENT_SAVE_MAX_BYTES + 1);
    const { result, parses } = countingParses(() => readSaveOps(over, watching));
    expect(result).toBeNull();
    expect(parses).toBe(0);
    expect(checks).toBe(0);
  });

  test('ops of exactly the save cap are read', () => {
    const atCap = opsTextOf(DOCUMENT_SAVE_MAX_BYTES);
    expect(bytes(atCap)).toBe(DOCUMENT_SAVE_MAX_BYTES);
    expect(readSaveOps(atCap, schema)).toHaveLength(1);
  });

  test('ops that are not JSON, or that the schema refuses, are not read', () => {
    expect(readSaveOps('[{"op":', schema)).toBeNull();
    expect(readSaveOps(JSON.stringify([{ op: 'rename', id: 'a' }]), schema)).toBeNull();
  });

  test('a check that throws is answered like ops that fail', () => {
    const throwing = {
      safeParse: (): never => {
        throw new RangeError('check failed');
      },
    };
    expect(readSaveOps(JSON.stringify([{ op: 'delete', id: 'a' }]), throwing)).toBeNull();
  });

  test('a page the size of the largest real one saves as ops', () => {
    const blocks = pageOfAtLeast(LARGEST_REAL_PAGE_BYTES);
    const ops = [];
    for (let at = 0; at < blocks.length; at += 400) {
      ops.push({ op: 'insert', blocks: blocks.slice(at, at + 400), position: { at: 'end' } });
    }
    const text = JSON.stringify(ops);
    expect(bytes(text)).toBeGreaterThan(LARGEST_REAL_PAGE_BYTES);
    expect(readSaveOps(text, schema)).toHaveLength(ops.length);
  });
});

test.describe('the page action answers unreadable ops so the editor falls back', () => {
  test('it reads ops only through readSaveOps, and answers null with OPS_MALFORMED', () => {
    expect(ACTION_SOURCE).toContain(
      'const ops = readSaveOps(data.ops, ClassmojiService.pageContent.pageBlockOpsPayloadSchema);'
    );
    expect(ACTION_SOURCE).toContain(
      'if (!ops) return Response.json(OPS_MALFORMED_ANSWER, { status: 400 });'
    );
    expect(ACTION_SOURCE).not.toMatch(/JSON\.parse\(data\.ops\)/);
    expect(OPS_MALFORMED_ANSWER.code).toBe('OPS_MALFORMED');
  });

  test('the editor takes that answer as a fallback, and re-sends the whole document once', () => {
    expect(isCodeFallbackRefusal(OPS_MALFORMED_ANSWER)).toBe(true);
    const effect = EDITOR_SOURCE.slice(
      EDITOR_SOURCE.indexOf('if (!fetcher.data?.code || fetcher.data?.conflict) return;')
    );
    expect(effect.length).toBeLessThan(EDITOR_SOURCE.length);
    expect(effect.slice(0, effect.indexOf('}, ['))).toContain(
      "{ intent: 'save', content, content_sha: contentToken }"
    );
  });
});

test.describe('a whole-document save is counted before it is parsed', () => {
  test('the action checks the document before JSON.parse and answers 413', () => {
    expect(ACTION_SOURCE).toMatch(
      /typeof data\.content === 'string' &&\s+textOverBytes\(data\.content, DOCUMENT_SAVE_MAX_BYTES\)/
    );
    const check = ACTION_SOURCE.indexOf('textOverBytes(data.content, DOCUMENT_SAVE_MAX_BYTES)');
    const parse = ACTION_SOURCE.indexOf('JSON.parse(data.content as string)');
    expect(check).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(check);
    expect(ACTION_SOURCE.slice(check, parse)).toContain(
      'return Response.json({ error: PAGE_TOO_LARGE_MESSAGE }, { status: 413 });'
    );
    expect(ACTION_SOURCE).toContain(
      'const PAGE_TOO_LARGE_MESSAGE = `This page is larger than the ${DOCUMENT_SAVE_MAX_LABEL} a page can hold.`;'
    );
  });

  test('a page sixteen times the largest real one is under the cap', () => {
    const text = JSON.stringify(pageOfAtLeast(16 * LARGEST_REAL_PAGE_BYTES));
    expect(textOverBytes(text, DOCUMENT_SAVE_MAX_BYTES)).toBe(false);
  });

  test('a document of exactly the cap is under it, one byte more is over', () => {
    const shell = JSON.stringify([{ type: 'paragraph', content: '' }]);
    const documentOf = (size: number) =>
      JSON.stringify([{ type: 'paragraph', content: 'x'.repeat(size - bytes(shell)) }]);
    expect(textOverBytes(documentOf(DOCUMENT_SAVE_MAX_BYTES), DOCUMENT_SAVE_MAX_BYTES)).toBe(false);
    expect(textOverBytes(documentOf(DOCUMENT_SAVE_MAX_BYTES + 1), DOCUMENT_SAVE_MAX_BYTES)).toBe(
      true
    );
  });
});
