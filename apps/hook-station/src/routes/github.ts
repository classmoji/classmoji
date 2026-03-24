// eslint-disable-next-line import/no-unresolved
import { Webhooks } from '@octokit/webhooks';
import Tasks from '@classmoji/tasks';

const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
});

const githubWebhookHandlers: Record<string, (data: any) => Promise<void>> = {
  closed: async (data: any) => {
    // data.issue is the GitHub issue payload from the webhook
    if (data.issue) {
      await Tasks.repositoryAssignmentClosedHandlerTask.trigger(data);
    }
  },

  member_added: async (data: any) => {
    await Tasks.memberAddedHandlerTask.trigger(data);
  },

  created: async (data: any) => {
    if (!data.repository && !data.issues && data.installation) {
      await Tasks.newInstallationHandlerTask.trigger(data);
    }
  },

  deleted: async (data: any) => {
    // data.issue is the GitHub issue payload from the webhook
    if (data.issue) {
      await Tasks.repositoryAssignmentDeletedHandlerTask.trigger(data);
    }
    // Handle GitHub App uninstallation
    if (data.installation && !data.issue && !data.repository) {
      await Tasks.appUninstalledHandlerTask.trigger(data);
    }
  },
};

export default async function githubRoutes(fastify: any): Promise<void> {
  fastify.post('/github', {
    preHandler: async function handler(request: any, reply: any) {
      const signature = request.headers['x-hub-signature-256'];
      if (!(await webhooks.verify(JSON.stringify(request.body), signature))) {
        reply.status(401).send('Unauthorized');
        return;
      }
    },
    handler: async function handler(request: any, reply: any) {
      const data = request.body;
      const handler = githubWebhookHandlers[data.action];
      if (handler) {
        await handler(data);
      }
      return reply.status(200).send({ success: true });
    },
  });
}
