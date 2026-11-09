/**
 * The per-request client stand-in Workers builds use (../requestScope.ts).
 */
import { describe, expect, it } from 'vitest';
import { createRequestScope } from '../requestScope.ts';

interface FakeClient {
  name: string;
  user: { who(): string };
  whoAmI(): string;
}

function scope() {
  let made = 0;
  const s = createRequestScope<FakeClient, string>(adapter => {
    made++;
    const client: FakeClient = {
      name: adapter,
      user: { who: () => adapter },
      whoAmI() {
        return this.name;
      },
    };
    return client;
  });
  return { ...s, made: () => made };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 1));

describe('createRequestScope', () => {
  it('creates no client until a request runs', () => {
    const s = scope();
    expect(s.made()).toBe(0);
  });

  it('throws a clear error when used outside a request', () => {
    const { client } = scope();
    expect(() => client.user).toThrow(/Prisma used outside a request \(property user\)/);
    expect(() => 'user' in client).toThrow(/outside a request/);
  });

  it('is not mistaken for a promise outside a request', async () => {
    const { client } = scope();
    expect((client as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(client)).resolves.toBe(client);
  });

  it("resolves to the running request's client, methods bound to it", async () => {
    const s = scope();
    // Captured at "import time", before any request, like better-auth's adapter.
    const captured = s.client;
    const result = await s.run('a', async () => {
      const { whoAmI } = captured;
      return [captured.name, captured.user.who(), whoAmI(), 'user' in captured];
    });
    expect(result).toEqual(['a', 'a', 'a', true]);
    expect(s.made()).toBe(1);
  });

  it('builds a fresh client for every request', async () => {
    const s = scope();
    await s.run('a', async () => {});
    await s.run('a', async () => {});
    expect(s.made()).toBe(2);
  });

  it('keeps concurrent requests isolated across awaits', async () => {
    const s = scope();
    const request = (name: string) =>
      s.run(name, async () => {
        const seen: string[] = [];
        for (let i = 0; i < 5; i++) {
          seen.push(s.client.name);
          await tick();
        }
        return seen;
      });
    const [a, b, c] = await Promise.all([request('a'), request('b'), request('c')]);
    expect(a).toEqual(Array(5).fill('a'));
    expect(b).toEqual(Array(5).fill('b'));
    expect(c).toEqual(Array(5).fill('c'));
  });

  it('is unusable again once the request is over', async () => {
    const s = scope();
    let later: Promise<unknown> = Promise.resolve();
    await s.run('a', async () => {
      later = Promise.resolve();
    });
    await later;
    expect(() => s.client.name).toThrow(/outside a request/);
  });
});
