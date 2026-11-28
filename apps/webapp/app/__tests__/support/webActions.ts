/**
 * Reads the webapp's route actions from their source text, for the web-action
 * audit manifest (routes/__tests__/webActionAudit.manifest.test.ts): which
 * route modules export an `action`, where that action's code lives (a
 * re-export is followed to its source), and the intents it handles, each with
 * the text that runs for it. A check of the text, not of a run.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROUTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../routes');
const REPO_ROOT = resolve(ROUTES_DIR, '../../../..');

/** Words after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'await',
  'yield',
  'else',
  'do',
]);

/**
 * `source` with its `//` and `/* *\/` comments removed. Strings, template
 * literals (their `${}` parts read as code) and regular expressions are kept
 * as written; line breaks are kept.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let depth = 0;
  const templates: number[] = [];
  let prev = '';
  let word = '';
  const wordAt = /[A-Za-z_$][\w$]*/y;
  const n = source.length;

  const templateChunk = () => {
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        out += '${';
        i += 2;
        templates.push(depth);
        prev = '{';
        word = '';
        return;
      } else {
        out += source[i++];
      }
    }
    out += source[i++] ?? '';
    prev = '`';
    word = '';
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out += ` ${source.slice(i, end).replace(/[^\n]/g, '')}`;
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      prev = c;
      word = '';
    } else if (c === '`') {
      out += c;
      i++;
      templateChunk();
    } else if (c === '}' && templates.length > 0 && templates.at(-1) === depth) {
      templates.pop();
      out += c;
      i++;
      templateChunk();
    } else if (
      c === '/' &&
      (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_AFTER.has(word))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(source[j])) j++;
      out += source.slice(i, j);
      i = j;
      prev = 'a';
      word = '';
    } else if (/[A-Za-z_$]/.test(c)) {
      wordAt.lastIndex = i;
      word = wordAt.exec(source)?.[0] ?? c;
      out += word;
      i += word.length;
      prev = 'a';
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c;
      i++;
      if (!/\s/.test(c)) {
        prev = c;
        word = '';
      }
    }
  }
  return out;
}

/**
 * The index just past the bracket that closes the one at `open` (`{`, `(` or
 * `[`), in comment-free source. Strings and template literals are skipped.
 */
export function matchingClose(source: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return source.length;
}

/** One route module of app/routes: its route id and the file that is the module. */
export interface RouteModule {
  id: string;
  file: string;
}

let cachedModules: RouteModule[] | null = null;

/** Every route module under app/routes (a folder's `route.*`, or a flat file). */
export function routeModules(): RouteModule[] {
  if (cachedModules) return cachedModules;
  const found: RouteModule[] = [];
  for (const entry of readdirSync(ROUTES_DIR).sort()) {
    if (entry === '__tests__' || entry.endsWith('.md')) continue;
    const path = join(ROUTES_DIR, entry);
    if (statSync(path).isDirectory()) {
      for (const name of ['route.tsx', 'route.ts', 'route.jsx', 'route.js']) {
        if (existsSync(join(path, name))) {
          found.push({ id: entry, file: join(path, name) });
          break;
        }
      }
    } else if (/\.(tsx|ts|jsx|js)$/.test(entry)) {
      found.push({ id: entry.replace(/\.(tsx|ts|jsx|js)$/, ''), file: path });
    }
  }
  cachedModules = found;
  return found;
}

/** The file a module specifier names, from `fromFile`; null when it is not ours. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const candidates = (base: string) => [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    join(base, 'route.tsx'),
    join(base, 'route.ts'),
  ];
  if (specifier.startsWith('.')) {
    return (
      candidates(resolve(dirname(fromFile), specifier)).find(
        c => existsSync(c) && statSync(c).isFile()
      ) ?? null
    );
  }
  if (specifier.startsWith('~/')) {
    return (
      candidates(resolve(ROUTES_DIR, '..', specifier.slice(2))).find(
        c => existsSync(c) && statSync(c).isFile()
      ) ?? null
    );
  }
  // A workspace package's subpath export (`@classmoji/auth/media-http`).
  const match = /^@classmoji\/([\w-]+)(\/.*)?$/.exec(specifier);
  if (!match) return null;
  for (const area of ['packages', 'apps']) {
    const pkgDir = join(REPO_ROOT, area, match[1]);
    const pkgJson = join(pkgDir, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const exportsMap = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { exports?: unknown }).exports;
    const key = `.${match[2] ?? ''}`;
    const target =
      exportsMap && typeof exportsMap === 'object'
        ? (exportsMap as Record<string, unknown>)[key]
        : null;
    const path =
      typeof target === 'string'
        ? target
        : target && typeof target === 'object'
          ? ((target as Record<string, unknown>).default as string | undefined)
          : undefined;
    if (path) return join(pkgDir, path);
  }
  return null;
}

/** Where a route module's action is written, and under which name. */
export interface ActionSource {
  /** The file holding the action's code. */
  file: string;
  /** The name it is declared under there (`action`, or a re-export's source name). */
  name: string;
  /** The route module whose own action this is, when the code is another route's. */
  routeId: string | null;
}

const OWN_ACTION = /^export\s+(?:const|let|async\s+function|function)\s+action\b/m;
const RE_EXPORT = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** Whether `file` declares `name` itself (exported or not). */
const declares = (text: string, name: string) =>
  new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|async\\s+function|function)\\s+${name}\\b`
  ).test(text);

/**
 * Where the action of the module in `file` lives, following re-exports (to a
 * sibling `action.ts`, another route, or a workspace package); null when the
 * module has no action.
 */
export function actionSource(file: string, name = 'action'): ActionSource | null {
  const text = readFileSync(file, 'utf8');
  if (name === 'action' ? OWN_ACTION.test(text) : declares(text, name)) {
    return { file, name, routeId: routeIdOf(file) };
  }
  for (const match of text.matchAll(RE_EXPORT)) {
    for (const part of match[1].split(',')) {
      const [from, as] = part.split(/\s+as\s+/).map(s => s.trim());
      if ((as ?? from) !== name || !from) continue;
      const target = resolveSpecifier(file, match[2]);
      if (!target) throw new Error(`${relative(ROUTES_DIR, file)}: cannot resolve ${match[2]}`);
      return actionSource(target, from);
    }
  }
  // `import { action } from './action'` … `export { action }`.
  for (const match of text.matchAll(/(?:^|\n)\s*export\s*\{([^}]*)\}\s*;?(?!\s*from)/g)) {
    for (const part of match[1].split(',')) {
      const [local, as] = part.split(/\s+as\s+/).map(s => s.trim());
      if ((as ?? local) !== name || !local) continue;
      for (const imported of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        for (const spec of imported[1].split(',')) {
          const [from, alias] = spec.split(/\s+as\s+/).map(s => s.trim());
          if ((alias ?? from) !== local) continue;
          const target = resolveSpecifier(file, imported[2]);
          if (!target) {
            throw new Error(`${relative(ROUTES_DIR, file)}: cannot resolve ${imported[2]}`);
          }
          return actionSource(target, from);
        }
      }
    }
  }
  return null;
}

/** Whether a module's text exports something named `action`, by any form. */
export const exportsAction = (file: string) =>
  /export\s+(?:const|let|async\s+function|function)\s+action\b|export\s*\{[^}]*\baction\b[^}]*\}/.test(
    readFileSync(file, 'utf8')
  );

/** The route id a file is the module of, or null for any other file. */
function routeIdOf(file: string): string | null {
  return routeModules().find(r => r.file === file)?.id ?? null;
}

/**
 * The text of the declaration of `name` in `source` (comment-free): from
 * `export const name =` / `function name(` to the end of its body.
 */
export function declarationText(source: string, name: string): string {
  const start = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let)\\s+${name}\\b[^=]*=|(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`
  ).exec(source);
  if (!start) throw new Error(`no declaration of ${name}`);
  const from = start.index + start[0].length;
  if (/function\s+[\w$]+$/.test(start[0])) {
    // `function name(…) { … }`: the block after the parameter list.
    const brace = source.indexOf('{', matchingClose(source, source.indexOf('(', from)));
    return source.slice(start.index, brace === -1 ? source.length : matchingClose(source, brace));
  }
  // `const name = …`: an arrow's body (a block, or an expression), or the
  // initializer up to the end of its statement.
  const arrow = /^\s*(?:async\s*)?(?:\([^]*?\)|[\w$]+)\s*(?::[^=;{]+)?=>\s*/.exec(
    source.slice(from)
  );
  if (arrow) {
    const params = source.indexOf('(', from);
    const head =
      params !== -1 && params < from + arrow[0].length
        ? matchingClose(source, params)
        : from + arrow[0].length;
    const bodyAt = source.indexOf('=>', head) + 2;
    const open = (/^\s*/.exec(source.slice(bodyAt))?.[0].length ?? 0) + bodyAt;
    if (source[open] === '{') return source.slice(start.index, matchingClose(source, open));
    return source.slice(start.index, statementEnd(source, open));
  }
  return source.slice(start.index, statementEnd(source, from));
}

/** The end of the statement (or expression) that starts at `at`: a `;` or a line end at depth 0. */
function statementEnd(source: string, at: number): number {
  for (let i = at; i < source.length; i++) {
    const c = source[i];
    if (c === '{' || c === '(' || c === '[') {
      i = matchingClose(source, i) - 1;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === ';' || c === '}' || c === ')') {
      return i;
    } else if (c === '\n' && !/^\s*[.?:|&+\-*/,]/.test(source.slice(i + 1, i + 40))) {
      // A line that does not continue the expression (`.then`, `? :`, `||`).
      const last = source.slice(at, i).trim().at(-1);
      if (last && !/[=(,?:|&+\-*/[{]/.test(last)) return i;
    }
  }
  return source.length;
}

/**
 * The action's declaration with the declarations of the functions of its own
 * file that it calls, two levels down (an action that hands its request to a
 * local `createPage(args)` is that function's code too), comment-free.
 */
export function reachableText(source: string, name: string): string {
  return withLocalCallees(source, declarationText(source, name), new Set([name]));
}

/**
 * `text` with the declarations of the functions of `source` that it calls,
 * two levels down (each once; `seen` are left out).
 */
export function withLocalCallees(source: string, start: string, seen = new Set<string>()): string {
  let text = start;
  for (let depth = 0; depth < 2; depth++) {
    const called = [...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
    for (const callee of called) {
      if (seen.has(callee)) continue;
      seen.add(callee);
      if (!declares(source, callee)) continue;
      try {
        text += `\n${declarationText(source, callee)}`;
      } catch {
        // Declared in a way this reader does not follow: its own text is skipped.
      }
    }
  }
  return text;
}

/** One intent an action handles, with the text that runs for it. */
export interface ActionIntent {
  intent: string;
  text: string;
}

/** The name an action dispatches on: an intent field, an operation param, a `_action`. */
const DISPATCH_NAME = /(?:^|\.)(?:intent|_intent|_action|operation|op|actionType|field)$/;

/**
 * The intents `action` (its declaration's text, comment-free) handles, in
 * source order:
 *   - the keys of the object handed to `namedAction(request, { … })`, each with
 *     its own body;
 *   - the string cases of a `switch` on an intent-like name (`intent`,
 *     `body.intent`, `_action`, `operation`), and the strings an intent-like
 *     name is compared with (`intent === 'create'`), each with the text from
 *     its case or comparison to the next; an action that compares also has
 *     `*`, its path for any other value (the whole action);
 *   - otherwise one unnamed intent, `*`, with the whole action.
 */
export function actionIntents(action: string): ActionIntent[] {
  const named = action.indexOf('namedAction(');
  if (named !== -1) {
    const open = action.indexOf('{', named);
    const close = matchingClose(action, open);
    const body = action.slice(open + 1, close - 1);
    const intents: ActionIntent[] = [];
    let i = 0;
    while (i < body.length) {
      const key = /\s*(?:async\s+)?(?:(['"])([\w.-]+)\1|([A-Za-z_$][\w$]*))\s*(\(|:)/y;
      key.lastIndex = i;
      const m = key.exec(body);
      if (!m) {
        i++;
        continue;
      }
      const intent = m[2] ?? m[3];
      const start = i;
      // The member's value: a method body, or the expression after `:`.
      let j = key.lastIndex;
      if (m[4] === '(') j = matchingClose(body, j - 1);
      const brace = body.indexOf('{', j);
      const comma = body.indexOf(',', j);
      const end =
        brace !== -1 && (comma === -1 || brace < comma) ? matchingClose(body, brace) : comma;
      const stop = end === -1 ? body.length : end;
      intents.push({ intent, text: body.slice(start, stop) });
      i = stop + 1;
    }
    return intents;
  }

  const marks: Array<{ intent: string; at: number }> = [];
  let compared = false;
  for (const m of action.matchAll(/switch\s*\(\s*([\w.]+)\s*\)\s*\{/g)) {
    if (!DISPATCH_NAME.test(m[1])) continue;
    const open = m.index + m[0].length - 1;
    const block = action.slice(open, matchingClose(action, open));
    for (const c of block.matchAll(/case\s+(['"])([\w.-]+)\1\s*:/g)) {
      marks.push({ intent: c[2], at: open + c.index });
    }
  }
  const guards: Array<[number, number]> = [];
  for (const m of action.matchAll(/([\w.]+)\s*===?\s*(['"])([\w.-]+)\2/g)) {
    if (!DISPATCH_NAME.test(m[1])) continue;
    compared = true;
    const guarded = guardedBlock(action, m.index);
    if (guarded && !guards.some(([from]) => from === guarded[0])) guards.push(guarded);
    if (marks.some(mark => mark.intent === m[3])) continue;
    marks.push({ intent: m[3], at: m.index });
  }
  if (marks.length === 0) return [{ intent: '*', text: action }];
  marks.sort((a, b) => a.at - b.at);
  // An intent dispatched in two places (two switches over one field) is one
  // intent, with the text of both.
  const byIntent = new Map<string, string>();
  marks.forEach((mark, k) => {
    // Two values compared in one condition (`a === 'x' || a === 'y'`) share
    // the code that follows it.
    let next = k + 1;
    while (next < marks.length && !/[{;]/.test(action.slice(mark.at, marks[next].at))) next++;
    const text = action.slice(mark.at, marks[next]?.at ?? action.length);
    byIntent.set(mark.intent, `${byIntent.get(mark.intent) ?? ''}${text}`);
  });
  const intents = [...byIntent].map(([intent, text]) => ({ intent, text }));
  if (!compared) return intents;
  // Comparisons leave a path for every other value (a save the action makes
  // when no intent matched, or its refusal): `*`, the action without the
  // blocks the comparisons guard.
  // Outermost first, from the end, so each cut leaves the others' offsets.
  const cuts = guards
    .filter(([from, to]) => !guards.some(([f, t]) => f < from && to <= t))
    .sort((a, b) => b[0] - a[0]);
  let rest = action;
  for (const [from, to] of cuts) rest = `${rest.slice(0, from)}${rest.slice(to)}`;
  return [...intents, { intent: '*', text: rest }];
}

/**
 * The `if (…) { … }` statement whose condition holds the comparison at `at`:
 * from `if` to the end of its block (an `else` branch is not part of it), or
 * undefined when the comparison is not an `if`'s condition.
 */
function guardedBlock(source: string, at: number): [number, number] | undefined {
  const before = source.slice(Math.max(0, at - 400), at);
  const ifs = [...before.matchAll(/(?<![\w$])if\s*\(/g)];
  if (ifs.length === 0) return undefined;
  const start = Math.max(0, at - 400) + ifs[ifs.length - 1].index;
  const paren = source.indexOf('(', start);
  if (paren === -1 || paren > at) return undefined;
  const condEnd = matchingClose(source, paren);
  if (condEnd <= at) return undefined;
  const after = /^\s*\{/.exec(source.slice(condEnd));
  if (!after) return undefined;
  return [start, matchingClose(source, condEnd + after[0].length - 1)];
}

/** One (route, intent) the webapp answers a POST to, with the code behind it. */
export interface WebActionIntent {
  /** The route id whose action this is (a re-export's source route). */
  routeId: string;
  intent: string;
  /** The intent's own text (comment-free). */
  text: string;
  /** The whole action's text (comment-free), for writers set up once per action. */
  action: string;
  /** Where the code is, relative to the repo root. */
  file: string;
}

/**
 * Every (route, intent) of the webapp: each route module that exports an
 * action, a re-export of another route's action counted once, under that
 * route. A re-export to a sibling file or a package is the module's own.
 */
export function webActionIntents(): WebActionIntent[] {
  const seen = new Set<string>();
  const out: WebActionIntent[] = [];
  for (const module of routeModules()) {
    const source = actionSource(module.file);
    if (!source) continue;
    // Another route's action: listed under that route.
    const routeId = source.routeId && source.routeId !== module.id ? source.routeId : module.id;
    const key = `${source.file}#${source.name}#${routeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const code = stripComments(readFileSync(source.file, 'utf8'));
    const action = reachableText(code, source.name);
    for (const { intent, text } of actionIntents(action)) {
      // The local functions this intent calls are its code too (those the
      // action's text already holds are read where they sit in it).
      const held = new Set(
        [
          ...action.matchAll(
            /(?:^|\n)\s*(?:export\s+)?(?:const|let|async\s+function|function)\s+([\w$]+)/g
          ),
        ].map(m => m[1])
      );
      const own = withLocalCallees(
        code,
        text,
        intent === '*' && text !== action ? held : new Set([source.name])
      );
      out.push({ routeId, intent, text: own, action, file: relative(REPO_ROOT, source.file) });
    }
  }
  return out;
}
