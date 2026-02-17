import Fastify from 'fastify';
import githubRoutes from './routes/github.js';
import stripeRoutes from './routes/stripe.js';
import autograderRoutes from './routes/autograder.js';

const fastify = Fastify({
  logger: true,
});

fastify.get('/', async function handler(request, reply) {
  return reply.status(200).send({ message: 'Welcome to Classflow Hook Station 🪝!' });
});

// Register route plugins
await fastify.register(githubRoutes, { prefix: '/webhooks/callback' });
await fastify.register(stripeRoutes, { prefix: '/webhooks/callback' });
await fastify.register(autograderRoutes);

// Start server
const PORT = process.env.PORT || 4000;
(async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🪝 Webhook server listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
})();
