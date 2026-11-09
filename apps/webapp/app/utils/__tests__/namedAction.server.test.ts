/**
 * The vendored copy of remix-utils 7.7.0's `namedAction`: every route action
 * dispatches through it, and the clients post `?/name` URLs (some with JSON
 * bodies) as well as `intent` and `_action` fields.
 */

import { describe, expect, it } from 'vitest';
import { namedAction } from '../namedAction.server';

const BASE = 'http://localhost/admin/cls/staff';

function actions() {
  return {
    one: async () => 'one',
    two: async () => 'two',
  };
}

function formPost(url: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new Request(url, { method: 'POST', body });
}

function jsonPost(url: string, payload: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('namedAction with a Request', () => {
  it('dispatches on a `?/name` URL with a JSON body', async () => {
    const request = jsonPost(`${BASE}?/two`, { intent: 'one' });
    await expect(namedAction(request, actions())).resolves.toBe('two');
    // The body is read from a clone only when needed; it stays readable.
    await expect(request.json()).resolves.toEqual({ intent: 'one' });
  });

  it('prefers the `?/name` URL over a name in the body', async () => {
    const request = formPost(`${BASE}?/two`, { intent: 'one', '/one': '' });
    await expect(namedAction(request, actions())).resolves.toBe('two');
  });

  it('reads `intent` from the query string before the body', async () => {
    const request = formPost(`${BASE}?intent=two`, { intent: 'one' });
    await expect(namedAction(request, actions())).resolves.toBe('two');
  });

  it('dispatches on a `/name` key in the FormData', async () => {
    const request = formPost(BASE, { '/two': '', intent: 'one' });
    await expect(namedAction(request, actions())).resolves.toBe('two');
  });

  it('dispatches on `intent`, then `action`, then `_action` in the FormData', async () => {
    await expect(
      namedAction(formPost(BASE, { _action: 'one', action: 'one', intent: 'two' }), actions())
    ).resolves.toBe('two');
    await expect(
      namedAction(formPost(BASE, { _action: 'one', action: 'two' }), actions())
    ).resolves.toBe('two');
    await expect(namedAction(formPost(BASE, { _action: 'two' }), actions())).resolves.toBe('two');
  });

  it('leaves the request body readable after reading the FormData', async () => {
    const request = formPost(BASE, { _action: 'one', title: 'x' });
    await expect(namedAction(request, actions())).resolves.toBe('one');
    expect((await request.formData()).get('title')).toBe('x');
  });

  it('runs `default` when no name is given', async () => {
    const request = formPost(BASE, { title: 'x' });
    await expect(
      namedAction(request, { ...actions(), default: async () => 'default' })
    ).resolves.toBe('default');
  });

  it('throws for an unknown name', async () => {
    await expect(namedAction(formPost(`${BASE}?/nope`, {}), actions())).rejects.toThrow(
      new ReferenceError('Action "nope" not found')
    );
    await expect(namedAction(formPost(BASE, { intent: 'nope' }), actions())).rejects.toThrow(
      ReferenceError
    );
  });

  it('does not fall back to `default` for an unknown name', async () => {
    await expect(
      namedAction(formPost(BASE, { intent: 'nope' }), {
        ...actions(),
        default: async () => 'default',
      })
    ).rejects.toThrow('Action "nope" not found');
  });

  it('throws when there is no name and no `default`', async () => {
    await expect(namedAction(formPost(BASE, { title: 'x' }), actions())).rejects.toThrow(
      new ReferenceError('Action name not found')
    );
  });

  it('cannot read a name from a JSON body without `?/name`', async () => {
    // As in 7.7.0: the body is parsed as FormData, which a JSON body is not.
    await expect(namedAction(jsonPost(BASE, { intent: 'one' }), actions())).rejects.toThrow(
      TypeError
    );
  });
});

describe('namedAction with other inputs', () => {
  it('reads a URL', async () => {
    await expect(namedAction(new URL(`${BASE}?/two`), actions())).resolves.toBe('two');
    await expect(namedAction(new URL(`${BASE}?_action=one`), actions())).resolves.toBe('one');
  });

  it('reads URLSearchParams', async () => {
    await expect(namedAction(new URLSearchParams('/two'), actions())).resolves.toBe('two');
    await expect(namedAction(new URLSearchParams('intent=one'), actions())).resolves.toBe('one');
    await expect(namedAction(new URLSearchParams('action=two'), actions())).resolves.toBe('two');
    await expect(namedAction(new URLSearchParams(''), actions())).rejects.toThrow(
      'Action name not found'
    );
  });

  it('reads FormData', async () => {
    const formData = new FormData();
    formData.append('intent', 'two');
    await expect(namedAction(formData, actions())).resolves.toBe('two');

    const keyed = new FormData();
    keyed.append('/one', '');
    await expect(namedAction(keyed, actions())).resolves.toBe('one');

    const unknown = new FormData();
    unknown.append('_action', 'nope');
    await expect(namedAction(unknown, actions())).rejects.toThrow('Action "nope" not found');
  });
});
