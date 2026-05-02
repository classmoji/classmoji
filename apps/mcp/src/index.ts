import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { requireValidJwt } from './auth/jwtValidator.ts';
import { resolveAuthContext, type AuthContext } from './auth/context.ts';
import { protectedResourceMetadata } from './resourceMetadata.ts';
import { buildServerForUser } from './server.ts';
import { rateLimitMcpEndpoint } from './middleware/rateLimiter.ts';
import { emitLog } from './middleware/logging.ts';

const PORT = Number(process.env.PORT ?? 8100);

const app = express();
app.use(express.json({ limit: '4mb' }));

// CORS — claude.ai is a browser client; Desktop and Code ignore CORS but it doesn't hurt them
app.use(
  cors({
    origin: ['https://claude.ai', 'https://claude.com'],
    allowedHeaders: ['Authorization', 'Content-Type', 'MCP-Session-Id', 'MCP-Protocol-Version'],
    exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
    credentials: false,
  })
);

// RFC 9728 — points Claude at the webapp AS
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);

// Health check (Fly.io probe, no auth)
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'classmoji-mcp', version: '1.0.0' });
});

// ─── MCP transport ────────────────────────────────────────────────────────
//
// Stateful Streamable HTTP per spec 2025-11-25:
//  - POST /mcp without Mcp-Session-Id and an InitializeRequest body → new session
//  - POST/GET/DELETE /mcp with Mcp-Session-Id → existing session
//
// Per-session McpServer instance built with the user's filtered tool surface.

interface SessionState {
  transport: StreamableHTTPServerTransport;
  ctx: AuthContext;
}

const sessions = new Map<string, SessionState>();

function getSessionId(req: Request): string | undefined {
  const v = req.headers['mcp-session-id'];
  return Array.isArray(v) ? v[0] : v;
}

app.post('/mcp', requireValidJwt, rateLimitMcpEndpoint, async (req, res) => {
  const sid = getSessionId(req);

  // Reuse existing session
  if (sid && sessions.has(sid)) {
    await sessions.get(sid)!.transport.handleRequest(req, res, req.body);
    return;
  }

  // Initialize new session
  if (!sid && isInitializeRequest(req.body)) {
    const ctx = await resolveAuthContext(
      req.auth!.extra!.userId,
      req.auth!.extra!.tokenId,
      req.auth!.clientId === 'unknown' ? null : req.auth!.clientId,
      req.auth!.scopes.join(' ')
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, ctx });
        emitLog({
          msg: 'mcp.session.opened',
          session_id: id,
          user_id: ctx.userId,
          access_token_id: ctx.accessTokenId,
          oauth_client_id: ctx.oauthClientId,
        });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        emitLog({ msg: 'mcp.session.closed', session_id: transport.sessionId });
      }
    };

    const server = buildServerForUser(ctx);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: invalid session or initialize request' },
    id: null,
  });
});

app.get('/mcp', requireValidJwt, async (req, res) => {
  const sid = getSessionId(req);
  if (!sid || !sessions.has(sid)) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  await sessions.get(sid)!.transport.handleRequest(req, res);
});

app.delete('/mcp', requireValidJwt, async (req, res) => {
  const sid = getSessionId(req);
  if (!sid || !sessions.has(sid)) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  await sessions.get(sid)!.transport.handleRequest(req, res);
});

// ─── Boot ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  emitLog({
    msg: 'mcp.boot',
    level: 'info',
    method: 'startup',
  });
  process.stdout.write(
    `[mcp] Listening on http://localhost:${PORT}\n` +
      `[mcp] Webapp (AS):  ${process.env.WEBAPP_URL ?? 'http://localhost:3001'}\n` +
      `[mcp] Public URL:   ${process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`}\n` +
      `[mcp] Audience:     ${process.env.MCP_AUDIENCE ?? `http://localhost:${PORT}/mcp`}\n`
  );
});
