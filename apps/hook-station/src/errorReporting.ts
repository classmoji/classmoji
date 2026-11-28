/**
 * Reports the errors a route throws that Fastify answers with a 5xx (or that
 * carry no status of their own, i.e. a bug rather than a refusal), without
 * touching the response: an `onError` hook runs before the error handler,
 * cannot send, and Fastify goes on to its default handler (which logs and
 * answers) whatever the hook does.
 *
 * Webhook bodies are never attached (Stripe events, Github and Gitlab
 * payloads, email events). Tags carry the route pattern, method, status, the
 * provider and, when the delivery names them in a well-formed header, its
 * event type and delivery id.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { reportError } from '@classmoji/utils/error-report';

const statusOf = (value: unknown): number | undefined =>
  typeof value === 'number' && value >= 400 && value <= 599 ? value : undefined;

/**
 * The status Fastify's default error handler will answer with: a code the
 * route already set (anything but the initial 200), else the error's own
 * `statusCode` / `status` (400-599), else 500 (fastify/lib/error-status.js).
 */
export function resultingStatus(reply: Pick<FastifyReply, 'statusCode'>, error: unknown): number {
  if (reply.statusCode !== 200) return reply.statusCode;
  const own = error as { statusCode?: unknown; status?: unknown } | null;
  return statusOf(own?.statusCode) ?? statusOf(own?.status) ?? 500;
}

/** Report a 5xx, or an error without a status (a bug, whatever the code says). */
export function isReportableRouteError(
  reply: Pick<FastifyReply, 'statusCode'>,
  error: unknown
): boolean {
  const own = error as { statusCode?: unknown; status?: unknown } | null;
  const hasStatus = statusOf(own?.statusCode) !== undefined || statusOf(own?.status) !== undefined;
  return resultingStatus(reply, error) >= 500 || !hasStatus;
}

/** A header value fit for a tag: short, plain characters only, else nothing. */
const headerTag = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w .:-]{1,64}$/.test(value) ? value : undefined;

/** `/webhooks/callback/github` → `github`; `/webhooks/callback/gitlab/:instanceId?` → `gitlab`. */
const providerOf = (route: string | undefined): string | undefined =>
  /^\/webhooks\/callback\/([a-z]+)/.exec(route ?? '')?.[1];

export function routeErrorTags(
  request: Pick<FastifyRequest, 'method' | 'headers'> & {
    routeOptions?: { url?: string };
  },
  status: number
): Record<string, string | number | undefined> {
  const route = request.routeOptions?.url;
  const { headers } = request;
  return {
    route,
    method: request.method,
    status,
    provider: providerOf(route),
    event: headerTag(headers['x-github-event'] ?? headers['x-gitlab-event']),
    delivery_id: headerTag(headers['x-github-delivery'] ?? headers['x-gitlab-event-uuid']),
  };
}

/** Add the reporting hook. Call before registering routes: child plugins inherit hooks added first. */
export function registerErrorReporting(fastify: FastifyInstance): void {
  fastify.addHook(
    'onError',
    async (request: FastifyRequest, reply: FastifyReply, error: FastifyError): Promise<void> => {
      if (!isReportableRouteError(reply, error)) return;
      reportError(error, {
        surface: 'hook_station.route',
        handled: false,
        tags: routeErrorTags(request, resultingStatus(reply, error)),
      });
    }
  );
}
