import { describe, expect, it, vi } from 'vitest';
import { ASK_MOJI_AVAILABILITY_COPY, ASK_MOJI_COPY } from '@classmoji/utils/ask-moji';
import { AskMojiApiError, createAskMojiApi } from '../api';

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('the panel’s API client', () => {
  it('posts JSON to the classroom’s routes, same-origin', async () => {
    const fetchImpl = respond(200, { publicAccessToken: 't' });
    const api = createAskMojiApi('cs 1', fetchImpl as never);
    await api.token({ conversationId: 'c1' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/ask-moji/cs%201/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ conversationId: 'c1' }),
    });
  });

  it('a refusal carries its line only when it is fixed copy', async () => {
    const api = createAskMojiApi(
      'cs1',
      respond(403, { code: 'X', message: 'Prisma error P2002 on ai_conversations' }) as never
    );
    const error = (await api.start({}).catch(e => e)) as AskMojiApiError;
    expect(error).toBeInstanceOf(AskMojiApiError);
    expect(error.line).toBe(ASK_MOJI_COPY.INIT_FAILED);

    const allowed = createAskMojiApi(
      'cs1',
      respond(429, { code: 'RATE_LIMITED', message: ASK_MOJI_COPY.RATE_LIMITED }) as never
    );
    expect(((await allowed.start({}).catch(e => e)) as AskMojiApiError).line).toBe(
      ASK_MOJI_COPY.RATE_LIMITED
    );
  });

  it('a staff line passes only when it is one of the availability lines', async () => {
    const good = createAskMojiApi(
      'cs1',
      respond(403, {
        code: 'UNAVAILABLE',
        message: ASK_MOJI_COPY.UNAVAILABLE,
        staffMessage: ASK_MOJI_AVAILABILITY_COPY.NO_API_KEY,
      }) as never
    );
    expect(((await good.start({}).catch(e => e)) as AskMojiApiError).staffLine).toBe(
      ASK_MOJI_AVAILABILITY_COPY.NO_API_KEY
    );
    const bad = createAskMojiApi(
      'cs1',
      respond(403, {
        code: 'UNAVAILABLE',
        message: ASK_MOJI_COPY.UNAVAILABLE,
        staffMessage: '<b>hi</b>',
      }) as never
    );
    expect(((await bad.start({}).catch(e => e)) as AskMojiApiError).staffLine).toBeNull();
  });

  it('a network failure or an unreadable body never shows its text', async () => {
    const down = createAskMojiApi(
      'cs1',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch http://10.0.0.1');
      }) as never
    );
    expect(
      ((await down.token({ conversationId: 'c' }).catch(e => e)) as AskMojiApiError).line
    ).toBe(ASK_MOJI_COPY.CONNECTION_FAILED);
    const html = createAskMojiApi(
      'cs1',
      vi.fn(async () => new Response('<html>', { status: 502 })) as never
    );
    expect(((await html.start({}).catch(e => e)) as AskMojiApiError).line).toBe(
      ASK_MOJI_COPY.INIT_FAILED
    );
  });

  it('state: a 404 is null (not the caller’s), other failures throw', async () => {
    expect(
      await createAskMojiApi('cs1', respond(404, { code: 'NOT_FOUND' }) as never).state({
        conversationId: 'c',
        knownLastMessageId: null,
      })
    ).toBeNull();
    await expect(
      createAskMojiApi('cs1', respond(500, {}) as never).state({
        conversationId: 'c',
        knownLastMessageId: null,
      })
    ).rejects.toBeInstanceOf(AskMojiApiError);
  });
});
