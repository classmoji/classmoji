/**
 * `setSentryUserId` only writes into a per-request isolation scope. Outside
 * one (a WebSocket handler, a timer, module scope, the request that was
 * already running when `initServerSentry` started) the current isolation
 * scope is the process-wide default, which every later scope copies: a user
 * set there would be on every later event, so the call does nothing.
 *
 * Real `@sentry/node` client, fake transport, no network, no ports.
 */
import { getDefaultIsolationScope, type Envelope } from '@sentry/core';
import { withIsolationScope } from '@sentry/node';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { flushErrorReports } from '../errorReport.ts';
import { captureServerException, initServerSentry, setSentryUserId } from '../sentryNode.ts';

const captured: Envelope[] = [];

beforeAll(() => {
  const on = initServerSentry(
    'mcp',
    { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0' },
    {
      transport: () => ({
        send: async envelope => {
          captured.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    }
  );
  expect(on).toBe(true);
});

beforeEach(() => {
  captured.length = 0;
});

const sentUsers = () =>
  captured.flatMap(([, items]) =>
    items
      .filter(([header]) => (header as { type: string }).type === 'event')
      .map(([, payload]) => (payload as { user?: unknown }).user)
  );

describe('setSentryUserId', () => {
  it('under View as sets no user id at all, only the impersonating tag', async () => {
    withIsolationScope(() => {
      setSentryUserId('viewed_user', { impersonating: true });
      captureServerException(new Error('viewed'));
    });
    withIsolationScope(() => {
      setSentryUserId('own_user');
      captureServerException(new Error('own'));
    });
    await flushErrorReports(2000);
    const events = captured.flatMap(([, items]) =>
      items
        .filter(([header]) => (header as { type: string }).type === 'event')
        .map(([, payload]) => payload as { user?: unknown; tags?: Record<string, unknown> })
    );
    expect(events).toHaveLength(2);
    expect(events[0].user).toBeUndefined();
    expect(events[0].tags?.impersonating).toBe('true');
    expect(JSON.stringify(events[0].user ?? null)).not.toContain('viewed_user');
    // The next request is not marked.
    expect(events[1].user).toEqual({ id: 'own_user' });
    expect(events[1].tags?.impersonating).toBeUndefined();
  });

  it('ties errors to the user inside a per-request scope', async () => {
    withIsolationScope(() => {
      setSentryUserId('user_in_request');
      captureServerException(new Error('in request'));
    });
    await flushErrorReports(2000);
    expect(sentUsers()).toEqual([{ id: 'user_in_request' }]);
    // The default scope was not touched.
    expect(getDefaultIsolationScope().getUser()).toEqual({});
  });

  it('does nothing outside one, so no later event carries that user', async () => {
    // As from a WebSocket handler, a timer or module scope.
    setSentryUserId('user_outside');
    expect(getDefaultIsolationScope().getUser()).toEqual({});
    captureServerException(new Error('outside'));
    // A later request that sets no user of its own.
    withIsolationScope(() => captureServerException(new Error('later request')));
    await flushErrorReports(2000);
    expect(sentUsers()).toEqual([undefined, undefined]);
  });

  it('clears the user of its own request with null', async () => {
    withIsolationScope(() => {
      setSentryUserId('user_1');
      setSentryUserId(null);
      captureServerException(new Error('cleared'));
    });
    await flushErrorReports(2000);
    expect(sentUsers()).toEqual([undefined]);
  });
});
