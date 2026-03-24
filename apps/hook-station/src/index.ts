import Fastify from 'fastify';
import githubRoutes from './routes/github.ts';
import stripeRoutes from './routes/stripe.ts';

const fastify = Fastify({
  logger: true,
});

fastify.get('/', async function handler(request: any, reply: any) {
  return reply.status(200).send({ message: 'Welcome to Classflow Hook Station 🪝!' });
});

// Register route plugins
await fastify.register(githubRoutes, { prefix: '/webhooks/callback' });
await fastify.register(stripeRoutes, { prefix: '/webhooks/callback' });

// Start server
const PORT = Number(process.env.PORT) || 4000;
(async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🪝 Webhook server listening on port ${PORT}`);
  } catch (err: any) {
    fastify.log.error(err);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
})();
