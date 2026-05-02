import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { auth, getAuthSession } from '@classmoji/auth/server';

/**
 * Dev-only JWT mint endpoint — unblocks parallel MCP server work.
 *
 * Returns a JWT signed by BetterAuth's jwt() plugin with the same shape
 * oauth-provider would issue. Useful for:
 *   - Building/testing apps/mcp before the full DCR + authorize + token
 *     flow is wired up
 *   - Unit-testing tools without running through Claude
 *   - CI integration tests
 *
 * REMOVED before any production merge — leaving an unauthenticated JWT mint
 * in production code is unforgivable. Hard-fails at module load if NODE_ENV
 * is production so accidental imports don't silently expose this.
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    '[SECURITY] api.dev.mint-jwt route loaded in production. This endpoint must NEVER ship to prod. Remove the file before deploy.'
  );
}

const ALL_RESOURCE_SCOPES = [
  'assignments:read', 'assignments:write',
  'modules:read', 'modules:write',
  'grades:read', 'grades:write',
  'calendar:read', 'calendar:write',
  'roster:read', 'roster:write',
  'content:read', 'content:write',
  'quizzes:read', 'quizzes:write',
  'tokens:read', 'tokens:write',
  'teams:read', 'teams:write',
  'regrade:read', 'regrade:write',
  'settings:read', 'settings:write',
  'feedback:read',
];

function expandScope(input: string): string {
  const tokens = input.split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (const t of tokens) {
    if (t === 'mcp:full') ALL_RESOURCE_SCOPES.forEach(s => out.add(s));
    else if (t === 'mcp:readonly')
      ALL_RESOURCE_SCOPES.filter(s => s.endsWith(':read')).forEach(s => out.add(s));
    else out.add(t);
  }
  return [...out].join(' ');
}

async function mint(request: Request) {
  const url = new URL(request.url);
  let userId = url.searchParams.get('user_id');
  const scope = url.searchParams.get('scope') ?? 'mcp:full';
  const audience = url.searchParams.get('aud') ?? process.env.MCP_AUDIENCE ?? 'http://localhost:8100/mcp';
  const expiresIn = Number(url.searchParams.get('expires_in') ?? 3600);

  // If no user_id provided, fall back to current session user
  if (!userId) {
    const session = await getAuthSession(request);
    userId = session?.userId ?? null;
  }

  if (!userId) {
    return Response.json(
      {
        error:
          'No user_id and no active session. Pass ?user_id=<uuid>, or sign in first and call again.',
      },
      { status: 400 }
    );
  }

  // Match oauth-provider's actual token shape: iss is `${baseURL}/api/auth`,
  // not just baseURL. signJWT's default uses baseURL so we set iss explicitly.
  const webappUrl = process.env.WEBAPP_URL ?? 'http://localhost:3001';
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    aud: [audience],
    azp: 'dev-mint-client',
    sid: `dev-${userId.slice(0, 8)}`,
    scope: expandScope(scope),
    iss: `${webappUrl}/api/auth`,
    iat: now,
    exp: now + expiresIn,
  };

  // BetterAuth's jwt() plugin: signJWT signs with the configured kty/alg
  // (default EdDSA Ed25519) using the jwks table key.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await (auth.api as any).signJWT({
    body: { payload },
  })) as { token: string };

  return Response.json({
    token: result.token,
    payload,
    decodedAt: `${process.env.WEBAPP_URL ?? 'http://localhost:3000'}/api/auth/jwks`,
    usage: `curl -H "Authorization: Bearer ${result.token}" ${audience.replace('/mcp', '/mcp')}`,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return mint(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return mint(request);
}
