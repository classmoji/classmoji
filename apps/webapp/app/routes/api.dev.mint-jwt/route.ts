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

/**
 * Even in non-production, this route is locked behind a secret header so
 * shared dev tunnels / dogfood deploys / preview environments don't expose
 * arbitrary-user MCP token minting to anyone who can reach the host. Set
 * `DEV_MINT_KEY` in `.env` to enable; pass it via `x-dev-mint-key` header.
 *
 * If unset, the route refuses to issue tokens — fail-closed.
 */
function authorize(request: Request): Response | null {
  const expected = process.env.DEV_MINT_KEY;
  if (!expected) {
    return Response.json(
      {
        error:
          'DEV_MINT_KEY is not set. Add it to your .env to enable the dev JWT mint endpoint.',
      },
      { status: 503 }
    );
  }
  const provided = request.headers.get('x-dev-mint-key');
  if (provided !== expected) {
    return Response.json(
      { error: 'Missing or invalid x-dev-mint-key header.' },
      { status: 401 }
    );
  }
  return null;
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
  const denied = authorize(request);
  if (denied) return denied;

  const url = new URL(request.url);
  let userId = url.searchParams.get('user_id');
  const scope = url.searchParams.get('scope') ?? 'mcp:full';
  const audience = url.searchParams.get('aud') ?? process.env.MCP_AUDIENCE ?? 'http://localhost:8100/mcp';
  const expiresIn = Number(url.searchParams.get('expires_in') ?? 3600);

  // Optional: dev "view-as" — filter the session's effective roles to a
  // subset of the user's actual classroom memberships. Useful when one user
  // holds OWNER+ASSISTANT+STUDENT in the dev classroom and you want to
  // simulate the student-only experience.
  //   ?roles=STUDENT
  //   ?roles=ASSISTANT,STUDENT
  const rolesParam = url.searchParams.get('roles');
  const viewAsRoles = rolesParam
    ? rolesParam
        .split(',')
        .map(r => r.trim().toUpperCase())
        .filter(r => ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'].includes(r))
    : null;

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
  const webappUrl = process.env.WEBAPP_URL ?? 'http://localhost:3000';
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: userId,
    aud: [audience],
    azp: 'dev-mint-client',
    sid: `dev-${userId.slice(0, 8)}`,
    scope: expandScope(scope),
    iss: `${webappUrl}/api/auth`,
    iat: now,
    exp: now + expiresIn,
  };
  // Custom non-reserved claim — Classmoji-specific role filter for view-as.
  // Read by apps/mcp/src/auth/context.ts → resolveAuthContext.
  if (viewAsRoles && viewAsRoles.length > 0) {
    payload.cm_roles = viewAsRoles;
  }

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
