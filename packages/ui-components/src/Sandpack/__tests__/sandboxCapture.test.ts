/**
 * What a code sandbox's submission reports from the running sandbox: the
 * console's lines (first line only, objects as JSON, `clear` and Sandpack's
 * own "Error in sandbox:" line dropped, capped), the error (cleaned of the
 * bundler's path prefix, position suffix and code frame; clamped to the
 * submission schema's caps), the seed's files only, and whether the files
 * hold an edit at all (`filesDiffer`, which never counts Sandpack's
 * re-serialized /package.json).
 *
 * The console entries and errors are the shapes live Sandpack produced for
 * the quiz mockup (plans/2026-10-12-quiz-sandbox/mockup.html, verify.mjs).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_LIMITS,
  capturedErrorsOf,
  cleanErrorMessage,
  clip,
  consoleLinesOf,
  consoleMethodOf,
  consoleTextOf,
  errorKindOf,
  filesAt,
} from '../sandboxCapture.ts';
import { filesDiffer } from '../utils.ts';
import { SANDBOX_SUPPORT_FILES } from '../constants.ts';

describe('consoleLinesOf', () => {
  it('keeps each entry as its method and text', () => {
    expect(
      consoleLinesOf([
        { method: 'log', data: ['Passed: 2'] },
        { method: 'warn', data: ['careful'] },
        { method: 'info', data: ['fyi'] },
        { method: 'debug', data: ['dbg'] },
      ])
    ).toEqual([
      { method: 'log', text: 'Passed: 2' },
      { method: 'warn', text: 'careful' },
      { method: 'info', text: 'fyi' },
      { method: 'debug', text: 'dbg' },
    ]);
  });

  it('keeps the first line of each string and joins arguments with a space', () => {
    expect(consoleLinesOf([{ method: 'log', data: ['a\nb', 'c\r\nd', 'e'] }])).toEqual([
      { method: 'log', text: 'a c e' },
    ]);
  });

  it('writes objects as JSON, and a value JSON cannot hold as text', () => {
    expect(consoleTextOf([{ name: 'Ada', score: 92 }, [1, 2], 3, null])).toBe(
      '{"name":"Ada","score":92} [1,2] 3 null'
    );
    expect(consoleTextOf([undefined])).toBe('undefined');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(consoleTextOf([circular])).toBe('[object Object]');
    expect(consoleTextOf(undefined)).toBe('');
  });

  it('drops clear entries and Sandpack\'s own "Error in sandbox:" line', () => {
    expect(
      consoleLinesOf([
        { method: 'clear', data: ['Console was cleared'] },
        { method: 'error', data: ['Error in sandbox:'] },
        {
          method: 'error',
          data: ["TypeError: Cannot read properties of undefined (reading 'map')"],
        },
      ])
    ).toEqual([
      { method: 'error', text: "TypeError: Cannot read properties of undefined (reading 'map')" },
    ]);
  });

  it('reports the other console methods as the schema has them', () => {
    expect(consoleMethodOf('assert')).toBe('error');
    expect(consoleMethodOf('warning')).toBe('warn');
    expect(consoleMethodOf('table')).toBe('log');
    expect(consoleMethodOf('count')).toBe('log');
    expect(consoleMethodOf('timeEnd')).toBe('log');
    expect(consoleMethodOf('clear')).toBeNull();
  });

  it("caps the number of lines and each line's length", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ method: 'log', data: [`line ${i}`] }));
    const lines = consoleLinesOf(many);
    expect(lines).toHaveLength(DEFAULT_CAPTURE_LIMITS.maxConsoleLines);
    expect(lines[0].text).toBe('line 0');

    const [long] = consoleLinesOf([{ method: 'log', data: ['x'.repeat(1000)] }]);
    expect(long.text).toHaveLength(DEFAULT_CAPTURE_LIMITS.maxConsoleLineChars);
    expect(long.text.endsWith('…')).toBe(true);

    expect(
      consoleLinesOf([{ method: 'log', data: ['abcdef'] }], {
        ...DEFAULT_CAPTURE_LIMITS,
        maxConsoleLines: 1,
        maxConsoleLineChars: 4,
      })
    ).toEqual([{ method: 'log', text: 'abc…' }]);
  });

  it('clips only what is too long', () => {
    expect(clip('abc', 3)).toBe('abc');
    expect(clip('abcd', 3)).toBe('ab…');
  });
});

describe('capturedErrorsOf', () => {
  it('cleans a runtime error as the mockup does', () => {
    expect(
      capturedErrorsOf({
        title: 'TypeError',
        message:
          "/index.js: Cannot read properties of undefined (reading 'map') (16:3)\n\n> 16 | x",
        path: '/index.js',
        line: 16,
        column: 3,
      })
    ).toEqual([
      {
        kind: 'runtime',
        title: 'TypeError',
        message: "Cannot read properties of undefined (reading 'map')",
        path: '/index.js',
        line: 16,
        column: 3,
      },
    ]);
  });

  it('reads a syntax error or a missing module as a compile error', () => {
    expect(errorKindOf('SyntaxError')).toBe('compile');
    expect(errorKindOf('ModuleNotFoundError')).toBe('compile');
    expect(errorKindOf('ReferenceError')).toBe('runtime');
    expect(errorKindOf(undefined)).toBe('runtime');
    const [syntax] = capturedErrorsOf({
      title: 'SyntaxError',
      message: '/index.js: Unexpected token (3:5)\n  1 | a\n> 3 | b',
      path: '/index.js',
      line: 3,
      column: 5,
    });
    expect(syntax).toMatchObject({ kind: 'compile', message: 'Unexpected token' });
  });

  it('has no error when Sandpack holds none', () => {
    expect(capturedErrorsOf(null)).toEqual([]);
    expect(capturedErrorsOf(undefined)).toEqual([]);
  });

  it('fills in what Sandpack leaves out, and never a value the schema refuses', () => {
    expect(capturedErrorsOf({ message: 'boom' })).toEqual([
      { kind: 'runtime', title: 'Error', message: 'boom', path: null, line: null, column: null },
    ]);
    expect(
      capturedErrorsOf({ title: 'Error', message: 'x', path: '', line: 0, column: -1 })
    ).toEqual([
      { kind: 'runtime', title: 'Error', message: 'x', path: null, line: null, column: null },
    ]);
    expect(
      capturedErrorsOf({ title: 'Error', message: 'x', line: 2.5, column: 0 })[0]
    ).toMatchObject({ line: null, column: 0 });
  });

  it('clamps the title and message, and drops a path that is too long', () => {
    const [error] = capturedErrorsOf({
      title: 'T'.repeat(300),
      message: 'm'.repeat(2000),
      path: `/${'p'.repeat(200)}.js`,
      line: 1,
      column: 0,
    });
    expect(error.title).toHaveLength(DEFAULT_CAPTURE_LIMITS.maxErrorTitleChars);
    expect(error.message).toHaveLength(DEFAULT_CAPTURE_LIMITS.maxErrorMessageChars);
    expect(error.path).toBeNull();
    expect(capturedErrorsOf({ message: 'x' }, { ...DEFAULT_CAPTURE_LIMITS, maxErrors: 0 })).toEqual(
      []
    );
  });

  it('strips only the prefix and the position suffix', () => {
    expect(cleanErrorMessage('/src/a.js: bad (1:2)')).toBe('bad');
    expect(cleanErrorMessage('plain (not a position)')).toBe('plain (not a position)');
    expect(cleanErrorMessage(undefined)).toBe('');
  });
});

describe('filesAt', () => {
  it("reads only the paths asked for, from Sandpack's file map", () => {
    expect(
      filesAt(
        {
          '/index.js': { code: 'js' },
          '/index.html': { code: 'html' },
          '/package.json': { code: '{}' },
        },
        ['/index.js', '/index.html', '/missing.css']
      )
    ).toEqual({ '/index.js': 'js', '/index.html': 'html' });
  });
});

describe('filesDiffer', () => {
  const seed = { '/index.js': 'a', '/index.html': '<p></p>' };

  it('is false for the seed as Sandpack holds it, template files and support files included', () => {
    expect(
      filesDiffer(seed, {
        '/index.js': { code: 'a' },
        '/index.html': { code: '<p></p>' },
        '/styles.css': { code: 'body {}' },
        '/package.json': { code: '{\n  "main": "/index.js"\n}' },
      })
    ).toBe(false);
  });

  it('is true once any seed file changes, or is gone', () => {
    expect(filesDiffer(seed, { '/index.js': 'b', '/index.html': '<p></p>' })).toBe(true);
    expect(filesDiffer(seed, { '/index.js': 'a' })).toBe(true);
  });

  it('matches paths with or without the leading slash', () => {
    expect(filesDiffer({ 'index.js': 'a' }, { '/index.js': { code: 'a' } })).toBe(false);
  });

  it("never counts Sandpack's re-serialized /package.json as an edit", () => {
    const pinned = SANDBOX_SUPPORT_FILES.vanilla['/package.json'];
    expect(
      filesDiffer(
        { '/package.json': pinned },
        {
          '/package.json': {
            code: JSON.stringify(
              { main: '/index.js', devDependencies: { '@babel/core': '7.24.0' }, dependencies: {} },
              null,
              2
            ),
          },
        }
      )
    ).toBe(false);
  });
});

describe('SANDBOX_SUPPORT_FILES', () => {
  it('pins Babel for vanilla, keeping main, hidden', () => {
    const pkg = SANDBOX_SUPPORT_FILES.vanilla['/package.json'];
    expect(pkg.hidden).toBe(true);
    expect(JSON.parse(pkg.code)).toEqual({
      main: '/index.js',
      devDependencies: { '@babel/core': '7.24.0' },
    });
  });

  it('leaves every other template its own package.json', () => {
    for (const template of ['vanilla-ts', 'react', 'react-ts']) {
      expect(SANDBOX_SUPPORT_FILES[template]).toEqual({});
    }
  });
});
