/**
 * PRIVACY: what a real `@sentry/node` client, started by `initServerSentry`,
 * actually puts on the wire for a request full of secrets. A fake transport
 * keeps every envelope (no network); the assertions read the serialized text,
 * so nothing can hide in a field the scrubber forgot.
 *
 * Two variants of the same request:
 * - a real `http.createServer` on port 0 (the SDK's httpIntegration builds
 *   the request's isolation scope itself), plus outgoing `fetch` and
 *   `http.request` calls to an echo server to prove no trace headers leave.
 *   Runs only where the environment lets a test bind a local port;
 * - a hand-built request scope, the way httpIntegration builds it
 *   (`withIsolationScope` + `setSDKProcessingMetadata({ normalizedRequest,
 *   ipAddress })`), with a request body the SDK would not even have read.
 *   Runs everywhere.
 *
 * The secret values live in ./fixtures/sentrySecrets.ts, never in this file
 * (see that module for why).
 */
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureException, getIsolationScope, setUser, withIsolationScope } from '@sentry/node';
import { httpRequestToRequestData, type Envelope } from '@sentry/core';
import { flushErrorReports, hasErrorReporter, reportError } from '../errorReport.ts';
import { captureServerException, initServerSentry, isServerSentryEnabled } from '../sentryNode.ts';
import * as secrets from './fixtures/sentrySecrets.ts';

const DSN = 'https://public@o0.ingest.sentry.io/0';
const captured: Envelope[] = [];

const canBind = await new Promise<boolean>(resolve => {
  const probe = http.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
});

beforeAll(() => {
  const on = initServerSentry(
    'webapp',
    { SENTRY_DSN: DSN, FLY_APP_NAME: 'classmoji-webapp-staging' },
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

const itemTypes = () =>
  captured.flatMap(([, items]) => items.map(([header]) => (header as { type: string }).type));

/** The parts of a sent event these tests read. */
type SentEvent = {
  environment?: string;
  transaction?: string;
  request?: { method?: string; url?: string };
  user?: unknown;
  tags: Record<string, unknown>;
  extra?: Record<string, unknown>;
  exception: {
    values: Array<{
      value?: string;
      mechanism?: Record<string, unknown>;
      stacktrace?: { frames?: Array<Record<string, unknown>> };
    }>;
  };
};

const events = () =>
  captured.flatMap(([, items]) =>
    items
      .filter(([header]) => (header as { type: string }).type === 'event')
      .map(([, payload]) => payload as SentEvent)
  );

const expectNothingSecret = () => {
  const text = JSON.stringify(captured);
  for (const secret of secrets.FORBIDDEN) expect(text, `leaked ${secret}`).not.toContain(secret);
  // No spans, transactions or sessions: errors only.
  for (const type of itemTypes()) expect(['event', 'client_report']).toContain(type);
};

const expectTheUsefulParts = (event: SentEvent) => {
  expect(event.environment).toBe('staging');
  expect(event.tags).toMatchObject({ app: 'webapp', runtime: 'server' });
  const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
  expect(frames.length).toBeGreaterThan(0);
  // The request's method and scrubbed URL are kept; nothing else about it.
  expect(event.request).toEqual({
    method: 'POST',
    url: expect.stringMatching(/\/join\/\[code\]$/),
  });
  expect(event.user).toEqual({ id: 'user_1' });
  for (const frame of frames) expect(frame).not.toHaveProperty('vars');
};

describe('initServerSentry privacy (real SDK, fake transport)', () => {
  it('is on and has registered the reporter', () => {
    expect(isServerSentryEnabled()).toBe(true);
    expect(hasErrorReporter()).toBe(true);
  });

  it('sends nothing secret for a hand-built request scope', async () => {
    const request = {
      method: 'POST',
      url: secrets.REQUEST_PATH,
      headers: { host: 'classmoji.test', ...secrets.REQUEST_HEADERS },
      // Bodies are never read (maxRequestBodySize 'none'); set one anyway to
      // prove the scrubber drops it too.
      body: secrets.REQUEST_BODY,
      cookies: { session: secrets.COOKIE_VALUE },
      socket: { remoteAddress: secrets.CLIENT_IP },
    };
    withIsolationScope(scope => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: httpRequestToRequestData(request as never),
        ipAddress: secrets.CLIENT_IP,
      });
      scope.setTransactionName(`POST ${request.url}`);
      setUser({ id: 'user_1', email: secrets.USER_EMAIL, ip_address: secrets.CLIENT_IP });
      captureServerException(new Error(secrets.ERROR_MESSAGE), { surface: 'test.handle_error' });
      reportError(new Error(secrets.ERROR_MESSAGE), {
        surface: 'test.choke_point',
        tags: { classroom_id: 'c1', path: secrets.REQUEST_PATH },
        extra: {
          attempts: 2,
          note: secrets.REQUEST_HEADERS.authorization,
          headers: secrets.REQUEST_HEADERS,
        },
      });
    });
    await flushErrorReports(2000);

    const sent = events();
    expect(sent).toHaveLength(2);
    expectNothingSecret();
    for (const event of sent) {
      expectTheUsefulParts(event);
      expect(event.transaction).toBe('POST /join/[code]');
      expect(event.exception.values[0].value).toBe(
        'upstream https://x.test/join/[code] refused Bearer [redacted]'
      );
    }
    const [handled, choke] = sent;
    expect(handled.tags.surface).toBe('test.handle_error');
    expect(handled.exception.values[0].mechanism).toMatchObject({
      type: 'generic',
      handled: false,
    });
    expect(choke.tags).toMatchObject({ surface: 'test.choke_point', classroom_id: 'c1' });
    expect(choke.exception.values[0].mechanism).toMatchObject({ type: 'generic', handled: true });
    expect(choke.extra).toEqual({ attempts: 2, note: 'Bearer [redacted]' });
  });

  it('never sends the contents of a non-Error value, and sends it once', async () => {
    const value = { note: secrets.BODY_SECRET, email: secrets.USER_EMAIL };
    withIsolationScope(() => {
      // As the SDK's own process and Express handlers capture it: raw.
      captureException(value);
      // Then a layer that reports the same object.
      reportError(value, { surface: 'test.choke_point' });
    });
    // And a value only the reporter sees (wrapped, contents never sent).
    reportError({ note: secrets.BODY_SECRET }, { surface: 'test.choke_point' });
    await flushErrorReports(2000);
    expect(events()).toHaveLength(2);
    expectNothingSecret();
  });

  it('reports one error object once across handleError and a choke point', async () => {
    withIsolationScope(() => {
      const error = new Error('one object');
      reportError(error, { surface: 'test.choke_point' });
      captureServerException(error, { surface: 'test.handle_error' });
      reportError(error, { surface: 'test.again' });
    });
    await flushErrorReports(2000);
    expect(events()).toHaveLength(1);
  });

  describe.runIf(canBind)('through a real HTTP server', () => {
    const outgoingHeaders: http.IncomingHttpHeaders[] = [];
    let echo: http.Server;
    let app: http.Server;
    let echoUrl = '';
    let appPort = 0;

    beforeAll(async () => {
      echo = http.createServer((req, res) => {
        outgoingHeaders.push(req.headers);
        res.end('ok');
      });
      echo.listen(0, '127.0.0.1');
      await once(echo, 'listening');
      echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/echo`;

      app = http.createServer(async (req, res) => {
        for await (const _chunk of req) {
          // drain the body
        }
        setUser({ id: 'user_1', email: secrets.USER_EMAIL, ip_address: secrets.CLIENT_IP });
        await fetch(echoUrl);
        await new Promise<void>((resolve, reject) => {
          http.get(echoUrl, incoming => incoming.resume().on('end', resolve)).on('error', reject);
        });
        captureServerException(new Error(secrets.ERROR_MESSAGE), { surface: 'test.handle_error' });
        res.statusCode = 500;
        res.end();
      });
      app.listen(0, '127.0.0.1');
      await once(app, 'listening');
      appPort = (app.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise(resolve => app?.close(resolve));
      await new Promise(resolve => echo?.close(resolve));
    });

    it('sends nothing secret, and no trace headers leave the process', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: appPort,
            path: secrets.REQUEST_PATH,
            method: 'POST',
            headers: secrets.REQUEST_HEADERS,
          },
          res => res.resume().on('end', () => resolve(res.statusCode ?? 0))
        );
        req.on('error', reject);
        req.end(secrets.REQUEST_BODY);
      });
      expect(status).toBe(500);
      await flushErrorReports(2000);

      const sent = events();
      expect(sent).toHaveLength(1);
      expectNothingSecret();
      expectTheUsefulParts(sent[0]);
      // The SDK, not this test, built the request scope.
      expect(sent[0].request?.url).toBe(`http://127.0.0.1:${appPort}/join/[code]`);
      expect(sent[0].transaction).toBe('POST /join/[code]');

      expect(outgoingHeaders).toHaveLength(2);
      for (const headers of outgoingHeaders) {
        expect(headers).not.toHaveProperty('sentry-trace');
        expect(headers).not.toHaveProperty('baggage');
        expect(headers).not.toHaveProperty('traceparent');
      }
      // The isolation scope was the request's own: nothing leaked into the
      // process-wide one.
      expect(getIsolationScope().getUser()).toEqual({});
    });
  });
});
