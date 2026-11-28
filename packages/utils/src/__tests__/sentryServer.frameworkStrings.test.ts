/**
 * `isOriginRefusal` and `isRenderAbort` recognise errors React Router and
 * React make themselves, by their message (the errors carry no other mark).
 * These tests read the INSTALLED react-router (development and production
 * builds, the one the servers load in production included) and react-dom
 * (Node and edge builds) and fail when those messages change, so the rules
 * cannot silently stop matching after an upgrade.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REACT_RENDER_ABORTS, REACT_ROUTER_ORIGIN_REFUSALS } from '../sentryServer.ts';

const require = createRequire(import.meta.url);
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`));
const read = (name: string, file: string) => readFileSync(join(packageDir(name), file), 'utf8');

describe('React Router origin refusals', () => {
  it.each(['development', 'production'])('are still thrown by react-router (%s build)', build => {
    const actions = read('react-router', `dist/${build}/lib/actions.js`);
    const singleFetch = read('react-router', `dist/${build}/lib/server-runtime/single-fetch.js`);
    const [mismatch, invalid, badRequest] = REACT_ROUTER_ORIGIN_REFUSALS;
    expect(actions).toContain(`throw new Error("${mismatch}")`);
    // A template literal in the source, its backticks escaped.
    expect(actions).toContain(`throw new Error(\`${invalid.replaceAll('`', '\\`')}\`)`);
    // The `.data` POST reports this one in place of the refusal itself.
    expect(singleFetch).toContain(`new Error("${badRequest}"), 400)`);
  });

  it('pins the react-router version they were read from', () => {
    expect(JSON.parse(read('react-router', 'package.json')).version).toBe('8.5.1');
  });
});

describe('React render aborts', () => {
  it.each([
    'cjs/react-dom-server.node.production.js',
    'cjs/react-dom-server.node.development.js',
    'cjs/react-dom-server.edge.production.js',
    'cjs/react-dom-server.edge.development.js',
  ])('are still the reasons react-dom gives (%s)', file => {
    const source = read('react-dom', file);
    const [closedEarly, withoutReason] = REACT_RENDER_ABORTS;
    expect(source).toContain(`Error("${withoutReason}")`);
    if (file.includes('.node.')) expect(source).toContain(`"${closedEarly}"`);
  });
});
