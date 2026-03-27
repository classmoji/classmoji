import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import githubRoutes from './routes/github.ts';
import stripeRoutes from './routes/stripe.ts';

const fastify = Fastify({
  logger: true,
});

fastify.get('/', async function handler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(200).send({ message: 'Welcome to Classflow Hook Station 🪝!' });
});

await fastify.register(githubRoutes, { prefix: '/webhooks/callback' });
await fastify.register(stripeRoutes, { prefix: '/webhooks/callback' });

const PORT = Number(process.env.PORT) || 4000;
(async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🪝 Webhook server listening on port ${PORT}`);
  } catch (err: unknown) {
    fastify.log.error(err);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
})();
