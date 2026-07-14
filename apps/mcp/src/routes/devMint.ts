/**
 * POST /dev/mint-token — dev-only token mint for integration tests (S8).
 *
 * DOUBLE-GATED exactly like apps/webapp/app/routes/test-login/route.tsx:
 * registered by src/index.ts ONLY when NODE_ENV === 'development' AND
 * ENABLE_TEST_LOGIN === 'true'; startup asserts it is absent otherwise.
 * NODE_ENV alone is not enough — a production misconfiguration (forgetting
 * NODE_ENV=production) would otherwise expose a mint-as-anyone backdoor.
 *
 * Mints a real oauth_access_tokens row for a seeded user so tests can drive
 * POST /mcp with a bearer token without the browser OAuth dance. Accepts a
 * negative expiresInSeconds to mint an already-expired token (for the
 * expiry-rejection test).
 *
 * Body: { login?: string, userId?: string, scopes?: string[], expiresInSeconds?: number }
 */

import { randomBytes } from 'node:crypto';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import type { FastifyInstance } from 'fastify';

const DEV_MINT_CLIENT_ID = 'classmoji-dev-mint';
const VALID_SCOPES = new Set(['read', 'write', 'openid', 'profile', 'email', 'offline_access']);

interface MintBody {
  login?: string;
  userId?: string;
  scopes?: string[];
  expiresInSeconds?: number;
}

export default async function devMintRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: MintBody }>('/dev/mint-token', async (request, reply) => {
    // Belt-and-suspenders: re-check the gates at request time too.
    if (process.env.NODE_ENV !== 'development' || process.env.ENABLE_TEST_LOGIN !== 'true') {
      return reply.status(404).send({ error: 'Not Found' });
    }

    const {
      login,
      userId,
      scopes = ['read', 'write'],
      expiresInSeconds = 3600,
    } = request.body ?? {};

    if (!login && !userId) {
      return reply.status(400).send({ error: "Provide 'login' or 'userId'" });
    }
    const invalid = scopes.filter(s => !VALID_SCOPES.has(s));
    if (invalid.length > 0) {
      return reply.status(400).send({ error: `Unknown scopes: ${invalid.join(', ')}` });
    }

    const user = userId
      ? await ClassmojiService.user.findById(userId)
      : await ClassmojiService.user.findByLogin(login as string);
    if (!user) {
      return reply
        .status(404)
        .send({ error: `User not found — run 'npm run db:seed' for test users` });
    }

    const prisma = getPrisma();
    // The token row FKs oauth_applications.client_id — keep one dev app around.
    await prisma.oauthApplication.upsert({
      where: { clientId: DEV_MINT_CLIENT_ID },
      update: {},
      create: {
        name: 'Classmoji Dev Token Mint',
        clientId: DEV_MINT_CLIENT_ID,
        clientSecret: '',
        redirectUrls: '',
        type: 'public',
        disabled: false,
      },
    });

    const now = Date.now();
    const accessTokenExpiresAt = new Date(now + expiresInSeconds * 1000);
    const token = await prisma.oauthAccessToken.create({
      data: {
        accessToken: `dev-${randomBytes(24).toString('hex')}`,
        refreshToken: `dev-refresh-${randomBytes(24).toString('hex')}`,
        accessTokenExpiresAt,
        refreshTokenExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
        clientId: DEV_MINT_CLIENT_ID,
        userId: user.id,
        scopes: scopes.join(' '),
      },
    });

    request.log.warn({ login: user.login, scopes, expiresInSeconds }, '[mcp] dev token minted');

    return reply.status(201).send({
      access_token: token.accessToken,
      user_id: user.id,
      login: user.login,
      scopes,
      access_token_expires_at: accessTokenExpiresAt.toISOString(),
    });
  });
}
