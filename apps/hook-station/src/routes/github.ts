import { Webhooks } from '@octokit/webhooks';
import type { WebhookEvent } from '@octokit/webhooks-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Tasks from '@classmoji/tasks';

const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
});

const githubWebhookHandlers: Record<string, (data: WebhookEvent) => Promise<void>> = {
  closed: async (data: WebhookEvent) => {
    if ('issue' in data && data.issue) {
      await Tasks.repositoryAssignmentClosedHandlerTask.trigger(data);
    }
  },

  member_added: async (data: WebhookEvent) => {
    await Tasks.memberAddedHandlerTask.trigger(
      data as unknown as Parameters<typeof Tasks.memberAddedHandlerTask.trigger>[0]
    );
  },

  created: async (data: WebhookEvent) => {
    if (
      !('repository' in data) &&
      !('issues' in data) &&
      'installation' in data &&
      data.installation
    ) {
      await Tasks.newInstallationHandlerTask.trigger(
        data as unknown as Parameters<typeof Tasks.newInstallationHandlerTask.trigger>[0]
      );
    }
  },

  deleted: async (data: WebhookEvent) => {
    if ('issue' in data && data.issue) {
      await Tasks.repositoryAssignmentDeletedHandlerTask.trigger(data);
    }

    if (
      'installation' in data &&
      data.installation &&
      !('issue' in data) &&
      !('repository' in data)
    ) {
      await Tasks.appUninstalledHandlerTask.trigger(
        data as unknown as Parameters<typeof Tasks.appUninstalledHandlerTask.trigger>[0]
      );
    }
  },
};

export default async function githubRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/github', {
    preHandler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const signature = request.headers['x-hub-signature-256'];
      if (typeof signature !== 'string') {
        reply.status(401).send('Unauthorized');
        return;
      }

      if (!(await webhooks.verify(JSON.stringify(request.body), signature))) {
        reply.status(401).send('Unauthorized');
      }
    },
    handler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const data = request.body as WebhookEvent;
      const action = 'action' in data ? data.action : undefined;
      const handler = action ? githubWebhookHandlers[action] : undefined;

      if (handler) {
        await handler(data);
      }

      return reply.status(200).send({ success: true });
    },
  });
}
