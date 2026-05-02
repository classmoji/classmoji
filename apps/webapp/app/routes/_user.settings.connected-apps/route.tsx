import { Alert, Button, Card, Empty, List, Space, Tag, Tooltip, Typography, message } from 'antd';
import { Form, redirect, useNavigation, useFetcher } from 'react-router';
import {
  IconPlug,
  IconTrash,
  IconCopy,
  IconBrandGithub,
  IconCalendarEvent,
} from '@tabler/icons-react';

import type { Route } from './+types/route';
import { auth, getAuthSession } from '@classmoji/auth/server';

const { Title, Text, Paragraph } = Typography;

// ─── Loader ──────────────────────────────────────────────────────────────────

interface ConsentRow {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
}

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);
  if (!authData?.userId) {
    return redirect('/?redirect=/settings/connected-apps');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = auth.api as any;
  const consents = (await api
    .getOAuthConsents({ headers: request.headers })
    .catch(() => [])) as Array<{
    id: string;
    clientId: string;
    scopes: string[];
    createdAt: string | Date;
  }>;

  // Look up client metadata in parallel for each consent.
  // getOAuthClientPublic uses GET with query; response field is client_name.
  const rows: ConsentRow[] = await Promise.all(
    consents.map(async c => {
      let name = c.clientId;
      try {
        const client = (await api.getOAuthClientPublic({
          query: { client_id: c.clientId },
          headers: request.headers,
        })) as { client_name?: string } | null;
        if (client?.client_name) name = client.client_name;
      } catch {
        /* fall back to clientId */
      }
      return {
        id: c.id,
        clientId: c.clientId,
        clientName: name,
        scopes: c.scopes ?? [],
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : c.createdAt.toISOString(),
      };
    })
  );

  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    rows,
    mcpUrl: process.env.MCP_PUBLIC_URL ?? 'https://mcp.classmoji.io/mcp',
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }: Route.ActionArgs) => {
  const authData = await getAuthSession(request);
  if (!authData?.userId) return redirect('/sign-in');

  const formData = await request.formData();
  const consentId = String(formData.get('consentId') ?? '');
  if (!consentId) return { ok: false, error: 'Missing consentId' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (auth.api as any).deleteOAuthConsent({
    body: { id: consentId },
    headers: request.headers,
  });

  return redirect('/settings/connected-apps');
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function summarizeScopes(scopes: string[]): string {
  if (scopes.includes('mcp:full')) return 'Full access (read + write all classroom data)';
  if (scopes.includes('mcp:readonly')) return 'Read-only access';

  const families = new Set<string>();
  for (const s of scopes) {
    if (s === 'openid' || s === 'profile' || s === 'email' || s === 'offline_access') continue;
    const [family] = s.split(':');
    if (family) families.add(family);
  }
  if (families.size === 0) return scopes.join(', ');
  return [...families].sort().join(', ');
}

// ─── UI ──────────────────────────────────────────────────────────────────────

export default function ConnectedAppsRoute({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting' || fetcher.state === 'submitting';
  const { rows, mcpUrl } = loaderData;

  const copyMcp = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      message.success('MCP URL copied');
    } catch {
      message.error('Could not copy — please copy manually');
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <div>
        <Title level={4} style={{ marginBottom: 4 }}>
          <IconPlug size={20} style={{ verticalAlign: 'text-bottom', marginRight: 8 }} />
          Connected Apps
        </Title>
        <Paragraph type="secondary">
          Manage AI assistants and other applications that have access to your Classmoji
          account via OAuth.
        </Paragraph>
      </div>

      {/* ─── Authorized list ─────────────────────────────────────────────── */}
      <Card title="Authorized applications" bordered>
        {rows.length === 0 ? (
          <Empty
            description={
              <span>
                No applications connected yet.
                <br />
                Add the Classmoji MCP server to your AI assistant — see setup instructions below.
              </span>
            }
          />
        ) : (
          <List
            dataSource={rows}
            renderItem={row => (
              <List.Item
                actions={[
                  <fetcher.Form key="revoke" method="post">
                    <input type="hidden" name="consentId" value={row.id} />
                    <Tooltip title="Revoke access">
                      <Button
                        danger
                        type="text"
                        icon={<IconTrash size={16} />}
                        htmlType="submit"
                        loading={submitting && fetcher.formData?.get('consentId') === row.id}
                      >
                        Disconnect
                      </Button>
                    </Tooltip>
                  </fetcher.Form>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Text strong>{row.clientName}</Text>
                      <Tag>{summarizeScopes(row.scopes)}</Tag>
                    </Space>
                  }
                  description={
                    <Space size="small" style={{ fontSize: 12, color: '#888' }}>
                      <span>
                        <IconCalendarEvent
                          size={12}
                          style={{ verticalAlign: 'text-bottom', marginRight: 4 }}
                        />
                        Authorized {new Date(row.createdAt).toLocaleDateString()}
                      </span>
                      <span>·</span>
                      <span>
                        <code style={{ fontSize: 11 }}>
                          {row.clientId.slice(0, 12)}…
                        </code>
                      </span>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* ─── Setup instructions ──────────────────────────────────────────── */}
      <Card title="Connect a new app" bordered>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="MCP server URL"
            description={
              <Space>
                <code style={{ fontSize: 13 }}>{mcpUrl}</code>
                <Button size="small" icon={<IconCopy size={14} />} onClick={copyMcp}>
                  Copy
                </Button>
              </Space>
            }
          />

          <div>
            <Text strong>claude.ai (Pro / Team / Enterprise)</Text>
            <ol style={{ marginTop: 8 }}>
              <li>Open claude.ai → Settings → Connectors</li>
              <li>Click "Add custom connector"</li>
              <li>
                Paste the MCP URL above (<code>{mcpUrl}</code>) and follow the OAuth prompt
              </li>
              <li>
                Optionally, add an instruction in Settings → Personal Preferences like:
                <em>
                  "When working with Classmoji, call <code>classrooms_list</code> at the
                  start of the conversation to ground context."
                </em>
              </li>
            </ol>
          </div>

          <div>
            <Text strong>Claude Desktop</Text>
            <ol style={{ marginTop: 8 }}>
              <li>Open Claude Desktop → Settings → Integrations</li>
              <li>Click "Add custom MCP" and paste the URL above</li>
              <li>Browser opens for OAuth — complete sign-in</li>
            </ol>
          </div>

          <div>
            <Text strong>
              <IconBrandGithub
                size={14}
                style={{ verticalAlign: 'text-bottom', marginRight: 4 }}
              />
              Claude Code CLI
            </Text>
            <pre
              style={{
                background: '#f6f8fa',
                padding: 12,
                borderRadius: 4,
                fontSize: 12,
                marginTop: 8,
              }}
            >
              {`claude mcp add --transport http classmoji ${mcpUrl}\n# Then inside a Claude Code session:\n/mcp     # triggers the OAuth flow in your browser`}
            </pre>
          </div>
        </Space>
      </Card>
    </div>
  );
}
