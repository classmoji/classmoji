import Tasks from '@classmoji/tasks';

export default async function autograderRoutes(fastify) {
  fastify.post('/autograder', async function handler(request, reply) {
    Tasks.autogradeRepositoryAssignmentTask.trigger(request.body);
    return reply.status(200).send({ success: true });
  });
}
