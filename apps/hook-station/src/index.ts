import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import githubRoutes from './routes/github.ts';
import stripeRoutes from './routes/stripe.ts';
import resendRoutes from './routes/resend.ts';

const fastify = Fastify({
  logger: true,
});

await fastify.register(fastifyRawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true,
});

fastify.get('/', async function handler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(200).send({ message: 'Welcome to Classflow Hook Station 🪝!' });
});

await fastify.register(githubRoutes, { prefix: '/webhooks/callback' });
await fastify.register(stripeRoutes, { prefix: '/webhooks/callback' });
// Registered unconditionally, and it reads its secret per request rather than
// at import: an unconfigured deployment must answer 503 on this one path, not
// fail to boot and take GitHub and Stripe down with it. See routes/resend.ts.
await fastify.register(resendRoutes, { prefix: '/webhooks/callback' });

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
