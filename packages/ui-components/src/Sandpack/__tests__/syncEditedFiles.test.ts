// @vitest-environment jsdom
/**
 * Writing the live editor's files back into a Sandpack block.
 *
 * Sandpack reports its whole file map — the template's files with the block's
 * files on top, /package.json re-serialized — on mount and after every edit.
 * Written back verbatim, that injected the template's /styles.css and
 * /package.json into every block the moment the editor opened (and the block
 * then opened on the CSS tab). The mount report is the baseline and is never
 * written; later reports write the block's own files that changed, plus any
 * template file the user actually edited, onto what the element stores now.
 *
 * The live maps here are built with Sandpack's own template table and
 * package.json step, so a Sandpack upgrade that changes either fails here.
 */

import { describe, expect, it } from 'vitest';
import { SANDBOX_TEMPLATES } from '@codesandbox/sandpack-react';
import { addPackageJSONIfNeeded } from '@codesandbox/sandpack-client';
import { SandpackEditTracker, mergeEditedFiles, syncEditedFiles } from '../utils.ts';

type Files = Record<string, string>;

interface TemplateSetup {
  files: Record<string, { code: string }>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * The map Sandpack reports for a block's files: what getSandpackStateFromProps
 * builds with a template and no customSetup (template files, block files on
 * top, then addPackageJSONIfNeeded with the template's dependencies), as
 * FileSyncListener flattens it to path → code.
 */
function sandpackReport(
  template: 'react' | 'vanilla',
  blockFiles: Files,
  edits: Files = {}
): Files {
  const setup = (SANDBOX_TEMPLATES as unknown as Record<string, TemplateSetup>)[template];
  const files: Record<string, { code: string }> = { ...setup.files };
  for (const [path, code] of Object.entries(blockFiles)) {
    files[path.startsWith('/') ? path : `/${path}`] = { code };
  }
  const withPackage = addPackageJSONIfNeeded(
    files,
    { ...setup.dependencies },
    { ...setup.devDependencies },
    undefined
  );
  const report: Files = {};
  for (const [path, file] of Object.entries(withPackage)) report[path] = file.code;
  return { ...report, ...edits };
}

const STORED: Files = {
  '/App.js': 'export default function App() { return <h1>Hi</h1>; }',
  '/package.json':
    '{"dependencies":{"react":"^19.0.0","react-dom":"^19.0.0","react-scripts":"^5.0.0","lodash":"4.17.21"},"main":"/index.js"}',
};

const MOUNT = sandpackReport('react', STORED);

function embedWith(payload: string, attrs = 'data-template="react"'): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = `<div class="sandpack-embed" ${attrs}><script type="application/json" data-sandpack-files>${payload}</script></div>`;
  return host.firstElementChild as HTMLElement;
}

const payloadOf = (el: HTMLElement) =>
  el.querySelector('script[data-sandpack-files]')?.textContent ?? '';

describe('the live map this suite works against', () => {
  it('carries template files the block does not store, and a re-serialized package.json', () => {
    expect(MOUNT['/styles.css']).toBeDefined();
    expect(MOUNT['/index.js']).toBeDefined();
    expect(MOUNT['/package.json']).not.toBe(STORED['/package.json']);
  });
});

describe('mergeEditedFiles', () => {
  it('nothing edited: no write, template files and package.json re-serialization ignored', () => {
    expect(mergeEditedFiles(STORED, MOUNT, MOUNT)).toBeNull();
    expect(mergeEditedFiles(STORED, MOUNT)).toBeNull();
  });

  it('one stored file edited: only that file changes, template files stay out', () => {
    const merged = mergeEditedFiles(
      STORED,
      sandpackReport('react', STORED, { '/App.js': 'edited' }),
      MOUNT
    );
    expect(merged).toEqual({ ...STORED, '/App.js': 'edited' });
    expect(Object.keys(merged ?? {})).toEqual(['/App.js', '/package.json']);
  });

  it('a real package.json edit is written', () => {
    const edited = '{\n  "dependencies": {\n    "lodash": "4.17.20"\n  }\n}';
    const live = sandpackReport('react', STORED, { '/package.json': edited });
    expect(mergeEditedFiles(STORED, live, MOUNT)).toEqual({ ...STORED, '/package.json': edited });
  });

  it('an edit to a template file Sandpack shows but the block does not store is saved', () => {
    // e.g. data-visible-files='["/App.js","/index.js"]' on a block storing only /App.js
    const stored = { '/App.js': STORED['/App.js'] };
    const mount = sandpackReport('react', stored);
    const live = sandpackReport('react', stored, { '/index.js': 'edited index' });
    expect(mergeEditedFiles(stored, live, mount)).toEqual({
      '/App.js': STORED['/App.js'],
      '/index.js': 'edited index',
    });
  });

  it('without a baseline, files the block does not store are never written', () => {
    const stored = { '/App.js': STORED['/App.js'] };
    const live = sandpackReport('react', stored, { '/index.js': 'edited index' });
    expect(mergeEditedFiles(stored, live)).toBeNull();
  });

  it('stored keys without a leading slash are matched and kept as stored', () => {
    const stored = { 'App.js': 'a' };
    const mount = sandpackReport('react', stored);
    expect(mergeEditedFiles(stored, { ...mount, '/App.js': 'b' }, mount)).toEqual({
      'App.js': 'b',
    });
  });

  it('object-form entries keep their other keys', () => {
    const stored = { '/App.js': { code: 'a', active: true, hidden: false } };
    expect(mergeEditedFiles(stored, { '/App.js': 'b' })).toEqual({
      '/App.js': { code: 'b', active: true, hidden: false },
    });
  });
});

describe('SandpackEditTracker', () => {
  it('the mount report is the baseline and is never reported as an edit', () => {
    const tracker = new SandpackEditTracker();
    const source = { ...STORED };
    expect(tracker.observe(source, MOUNT)).toBeNull();
    const live = sandpackReport('react', STORED, { '/App.js': 'edited' });
    expect(tracker.observe(source, live)).toBe(MOUNT);
  });

  it('after new files, a stale report is skipped and the reset report becomes the baseline', () => {
    const tracker = new SandpackEditTracker();
    tracker.observe(STORED, MOUNT);

    // Template switched to vanilla with its starter files: the first report
    // can still be the react state, then Sandpack resets.
    const vanillaFiles = { '/index.html': '<div></div>', '/index.js': 'start' };
    expect(tracker.observe(vanillaFiles, MOUNT)).toBeNull();
    const vanillaMount = sandpackReport('vanilla', vanillaFiles);
    expect(tracker.observe(vanillaFiles, vanillaMount)).toBeNull();

    const live = sandpackReport('vanilla', vanillaFiles, { '/index.js': 'edited' });
    const baseline = tracker.observe(vanillaFiles, live);
    expect(baseline).toBe(vanillaMount);
    expect(mergeEditedFiles(vanillaFiles, live, baseline ?? undefined)).toEqual({
      ...vanillaFiles,
      '/index.js': 'edited',
    });
  });
});

describe('syncEditedFiles', () => {
  it('mount alone never writes or marks the deck dirty', () => {
    const payload = JSON.stringify(STORED);
    const el = embedWith(payload, `data-template="react" data-visible-files='["/App.js"]'`);
    const tracker = new SandpackEditTracker();
    // What FileSyncListener does with the mount report: no baseline → no sync.
    expect(tracker.observe(STORED, MOUNT)).toBeNull();
    // Even handed straight to the sync, the mount map writes nothing.
    expect(syncEditedFiles(el, MOUNT, MOUNT)).toBe(false);
    expect(payloadOf(el)).toBe(payload);
  });

  it('an edit writes the block files only; the embed attributes are untouched', () => {
    const el = embedWith(
      JSON.stringify(STORED),
      `data-template="react" data-visible-files='["/App.js"]' data-show-line-numbers="false"`
    );
    const live = sandpackReport('react', STORED, { '/App.js': 'edited' });
    expect(syncEditedFiles(el, live, MOUNT)).toBe(true);
    expect(JSON.parse(payloadOf(el))).toEqual({ ...STORED, '/App.js': 'edited' });
    expect(el.getAttribute('data-visible-files')).toBe('["/App.js"]');
    expect(el.getAttribute('data-show-line-numbers')).toBe('false');
  });

  it('compares against what the element stores now, so an edit can be reverted', () => {
    const el = embedWith(JSON.stringify(STORED));
    syncEditedFiles(el, sandpackReport('react', STORED, { '/App.js': 'edited' }), MOUNT);
    expect(syncEditedFiles(el, MOUNT, MOUNT)).toBe(true);
    expect(JSON.parse(payloadOf(el))).toEqual(STORED);
  });

  it('a `</script>` in a file round-trips through the JSON', () => {
    const files = { '/index.html': '<body><script src="index.js"></script></body>' };
    const el = embedWith(
      JSON.stringify(files).replace(/<\/script>/gi, '<\\/script>'),
      'data-template="vanilla"'
    );
    const mount = sandpackReport('vanilla', files);
    const edited = '<body><script src="main.js"></script></body>';
    expect(syncEditedFiles(el, { ...mount, '/index.html': edited }, mount)).toBe(true);
    expect(JSON.parse(payloadOf(el))).toEqual({ '/index.html': edited });
  });

  it('an empty block edits the starter files it renders (DEFAULT_FILES)', () => {
    const el = embedWith('{}', 'data-template="vanilla"');
    expect(syncEditedFiles(el, { '/index.js': 'edited', '/package.json': '{}' })).toBe(true);
    const written = JSON.parse(payloadOf(el));
    expect(written['/index.js']).toBe('edited');
    expect(Object.keys(written).sort()).toEqual(['/index.html', '/index.js', '/styles.css']);
  });
});
