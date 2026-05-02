import { Button, Card, Space, Tag, Typography, Alert } from 'antd';
import { Form, redirect, useNavigation } from 'react-router';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';

import type { Route } from './+types/route';
import { Logo } from '@classmoji/ui-components';
import { auth, getAuthSession } from '@classmoji/auth/server';

const { Title, Text, Paragraph } = Typography;

// ─── Scope rollup ────────────────────────────────────────────────────────────
// Display 22 raw resource scopes as ~12 family-level UI rows.

const RESOURCE_LABELS: Record<string, string> = {
  assignments: 'Assignments',
  modules: 'Modules',
  grades: 'Grades',
  calendar: 'Calendar',
  roster: 'Roster (students, graders, invites)',
  content: 'Pages and slides',
  quizzes: 'Quizzes and attempts',
  tokens: 'Classroom tokens',
  teams: 'Teams',
  regrade: 'Regrade requests',
  settings: 'Classroom settings',
  feedback: 'GitHub feedback',
};

const IDENTITY_LABELS: Record<string, string> = {
  openid: 'Sign you in (OpenID)',
  profile: 'Your name and avatar',
  email: 'Your email address',
  offline_access: 'Stay connected when you’re away',
};

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

const COMPOSITES: Record<string, readonly string[]> = {
  'mcp:full': ALL_RESOURCE_SCOPES,
  'mcp:readonly': ALL_RESOURCE_SCOPES.filter(s => s.endsWith(':read')),
};

function expandScopes(scopeStr: string): Set<string> {
  const out = new Set<string>();
  for (const s of scopeStr.split(/\s+/).filter(Boolean)) {
    const composite = COMPOSITES[s];
    if (composite) composite.forEach(x => out.add(x));
    else out.add(s);
  }
  return out;
}

type RolledUpResource = { resource: string; label: string; actions: ('read' | 'write')[] };

function rollUpScopes(scopes: Set<string>): { identity: string[]; resources: RolledUpResource[] } {
  const identity: string[] = [];
  const resources = new Map<string, Set<'read' | 'write'>>();

  for (const s of scopes) {
    if (IDENTITY_LABELS[s]) {
      identity.push(IDENTITY_LABELS[s]);
      continue;
    }
    const [resource, action] = s.split(':');
    if (!resource || (action !== 'read' && action !== 'write')) continue;
    if (!RESOURCE_LABELS[resource]) continue;
    if (!resources.has(resource)) resources.set(resource, new Set());
    resources.get(resource)!.add(action);
  }

  const resourceList: RolledUpResource[] = [];
  for (const [resource, actions] of resources) {
    resourceList.push({
      resource,
      label: RESOURCE_LABELS[resource]!,
      actions: [...actions].sort(),
    });
  }
  resourceList.sort((a, b) => a.label.localeCompare(b.label));

  return { identity, resources: resourceList };
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);
  if (!authData?.userId) {
    // Not logged in — bounce to home (sign-in form). Preserve full URL so we
    // land back here. (Note: webapp doesn't yet support post-login redirect
    // back to the OAuth flow — for now the user must re-trigger the connector
    // add. Pre-login UX improvement is queued in plan §Open Decisions.)
    const returnTo = new URL(request.url).pathname + new URL(request.url).search;
    return redirect(`/?redirect=${encodeURIComponent(returnTo)}`);
  }

  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const scopeStr = url.searchParams.get('scope') ?? '';

  if (!clientId) {
    throw new Response('Missing client_id', { status: 400 });
  }

  // Look up the OAuth client (DCR-registered metadata) to display its name.
  // Note: getOAuthClientPublic is GET with query param; field name is client_name (snake_case per OAuth spec).
  let clientName = 'An application';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (await (auth.api as any).getOAuthClientPublic({
      query: { client_id: clientId },
      headers: request.headers,
    })) as { client_name?: string } | null;
    if (client?.client_name) {
      clientName = client.client_name;
    }
  } catch {
    // Best-effort — render the consent dialog even if client lookup fails.
  }

  return {
    clientName,
    scopes: rollUpScopes(expandScopes(scopeStr)),
    rawScope: scopeStr,
    oauthQuery: url.search.slice(1), // strip leading '?'
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────
//
// Proxies the form submission to BetterAuth's /api/auth/oauth2/consent
// endpoint. We can't use `auth.api.oauth2Consent()` directly because the
// endpoint relies on `oAuthState` cookies whose request-state plumbing
// doesn't survive the round-trip through React Router's action layer.
// Forwarding the live `Request` (cookies + body) preserves all the state
// BetterAuth needs.

export const action = async ({ request }: Route.ActionArgs) => {
  const formData = await request.formData();
  const decision = formData.get('decision');
  const scope = String(formData.get('scope') ?? '');
  const oauthQuery = String(formData.get('oauth_query') ?? '');

  const webappUrl = process.env.WEBAPP_URL ?? new URL(request.url).origin;
  const consentUrl = `${webappUrl}/api/auth/oauth2/consent`;

  const upstream = await fetch(consentUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Forward cookies so BetterAuth can read its session + state cookies.
      Cookie: request.headers.get('cookie') ?? '',
      // Node fetch doesn't set Origin on server-to-server calls; BetterAuth's
      // CSRF check rejects with MISSING_OR_NULL_ORIGIN without it.
      Origin: webappUrl,
    },
    body: JSON.stringify({
      accept: decision === 'approve',
      scope: scope || undefined,
      oauth_query: oauthQuery || undefined,
    }),
    redirect: 'manual',
  });

  // BetterAuth replies either with a 30x redirect (preferred) or JSON
  // containing { redirect: true, url } or { redirect_uri }.
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location');
    if (location) return redirect(location);
  }

  let payload: unknown = null;
  try {
    payload = await upstream.json();
  } catch {
    /* non-JSON response */
  }
  if (payload && typeof payload === 'object') {
    const p = payload as { redirect?: unknown; url?: unknown; redirect_uri?: unknown };
    if (p.redirect === true && typeof p.url === 'string') {
      return redirect(p.url);
    }
    if (typeof p.redirect_uri === 'string') {
      return redirect(p.redirect_uri);
    }
  }

  throw new Response(
    `Consent endpoint returned ${upstream.status}: ${JSON.stringify(payload)}`,
    { status: 500 }
  );
};

// ─── UI ──────────────────────────────────────────────────────────────────────

export default function OAuthConsent({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting';
  const { clientName, scopes, rawScope, oauthQuery } = loaderData;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--ant-color-bg-layout)',
      }}
    >
      <Card style={{ maxWidth: 560, width: '100%' }} bordered>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Logo />
          </div>

          <div>
            <Title level={3} style={{ marginBottom: 4 }}>
              Authorize {clientName}
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              <Text strong>{clientName}</Text> wants to access your Classmoji account on
              your behalf. Review the requested permissions below.
            </Paragraph>
          </div>

          {scopes.identity.length > 0 && (
            <div>
              <Text strong>Identity</Text>
              <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
                {scopes.identity.map(s => (
                  <li key={s}>
                    <Text>{s}</Text>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {scopes.resources.length > 0 && (
            <div>
              <Text strong>Classroom data</Text>
              <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
                {scopes.resources.map(r => (
                  <li key={r.resource} style={{ marginBottom: 4 }}>
                    <Text>{r.label}</Text>{' '}
                    {r.actions.map(a => (
                      <Tag
                        key={a}
                        color={a === 'write' ? 'orange' : 'blue'}
                        style={{ marginInlineStart: 4 }}
                      >
                        {a}
                      </Tag>
                    ))}
                  </li>
                ))}
              </ul>
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 12 }}
                message="The application will only see classrooms where you are a member, and only act with the role you hold in each."
              />
            </div>
          )}

          {scopes.identity.length === 0 && scopes.resources.length === 0 && (
            <Alert
              type="warning"
              showIcon
              message="No recognized scopes requested. You can still approve, but the application may not be able to do much."
            />
          )}

          <Form method="post" reloadDocument={false}>
            <input type="hidden" name="scope" value={rawScope} />
            <input type="hidden" name="oauth_query" value={oauthQuery} />
            <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
              <Button
                htmlType="submit"
                name="decision"
                value="deny"
                icon={<CloseCircleOutlined />}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="primary"
                htmlType="submit"
                name="decision"
                value="approve"
                icon={<CheckCircleOutlined />}
                loading={submitting}
              >
                Authorize
              </Button>
            </Space>
          </Form>

          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            You can revoke access at any time from{' '}
            <a href="/settings/connected-apps">Connected Apps</a> in your account settings.
          </Paragraph>
        </Space>
      </Card>
    </div>
  );
}
