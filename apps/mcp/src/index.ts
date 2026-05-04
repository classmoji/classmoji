import express, { type Request, type Response, type NextFunction } from 'express';
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

/**
 * Express 4 does not auto-route rejected promises from async handlers to
 * error middleware. Wrap async handlers so they always reach the final
 * error middleware below — without this, a thrown error from JWT context
 * resolution / DB call / SDK transport leaves the request hanging and may
 * trip Node's unhandled-rejection behavior.
 */
type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

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
  /**
   * Session-binding metadata captured from the JWT that initialized this
   * session. Reusing the session ID with a *different* JWT (different user,
   * different OAuth client, or even just a different token from the same
   * principal) is rejected — without this, a leaked Mcp-Session-Id plus any
   * valid Classmoji bearer would let the new bearer drive the original
   * user's session state.
   */
  bind: { userId: string; clientId: string; tokenId: string };
}

const sessions = new Map<string, SessionState>();

function getSessionId(req: Request): string | undefined {
  const v = req.headers['mcp-session-id'];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Verify the JWT on the request matches the JWT that opened this session.
 * Drop the session and return false if not — defense against session-id
 * leakage / cross-token reuse.
 */
function authorizeSessionReuse(
  sid: string,
  state: SessionState,
  req: Request,
  res: Response
): boolean {
  const reqUser = req.auth!.extra!.userId;
  const reqClient = req.auth!.clientId;
  const reqToken = req.auth!.extra!.tokenId;
  if (
    state.bind.userId !== reqUser ||
    state.bind.clientId !== reqClient ||
    state.bind.tokenId !== reqToken
  ) {
    sessions.delete(sid);
    state.transport.close().catch(() => {
      /* best effort */
    });
    emitLog({
      msg: 'mcp.session.bind_mismatch',
      level: 'warn',
      session_id: sid,
      user_id: state.bind.userId,
      oauth_client_id: state.bind.clientId,
      access_token_id: state.bind.tokenId,
      error: `request token (${reqUser}/${reqClient}) does not match bound (${state.bind.userId}/${state.bind.clientId})`,
    });
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session bound to a different token' },
      id: null,
    });
    return false;
  }
  return true;
}

app.post('/mcp', requireValidJwt, rateLimitMcpEndpoint, asyncHandler(async (req, res) => {
  const sid = getSessionId(req);

  // Reuse existing session — verify the caller matches the principal that
  // opened the session. Without this any valid bearer can hijack a leaked sid.
  if (sid && sessions.has(sid)) {
    const state = sessions.get(sid)!;
    if (!authorizeSessionReuse(sid, state, req, res)) return;
    await state.transport.handleRequest(req, res, req.body);
    return;
  }

  // Initialize new session
  if (!sid && isInitializeRequest(req.body)) {
    const ctx = await resolveAuthContext(
      req.auth!.extra!.userId,
      req.auth!.extra!.tokenId,
      req.auth!.clientId === 'unknown' ? null : req.auth!.clientId,
      req.auth!.scopes.join(' '),
      req.auth!.extra!.cmRoles
    );
    const bind = {
      userId: req.auth!.extra!.userId,
      clientId: req.auth!.clientId,
      tokenId: req.auth!.extra!.tokenId,
    };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, ctx, bind });
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
}));

app.get('/mcp', requireValidJwt, asyncHandler(async (req, res) => {
  const sid = getSessionId(req);
  if (!sid || !sessions.has(sid)) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  const state = sessions.get(sid)!;
  if (!authorizeSessionReuse(sid, state, req, res)) return;
  await state.transport.handleRequest(req, res);
}));

app.delete('/mcp', requireValidJwt, asyncHandler(async (req, res) => {
  const sid = getSessionId(req);
  if (!sid || !sessions.has(sid)) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  const state = sessions.get(sid)!;
  if (!authorizeSessionReuse(sid, state, req, res)) return;
  await state.transport.handleRequest(req, res);
}));

// Final error middleware — Express only treats a 4-arg handler as the error
// handler. Logs the error, returns a JSON 500 without leaking the stack to
// clients, and never throws from itself.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  emitLog({
    msg: 'mcp.request.error',
    level: 'error',
    method: req.method,
    error: message,
  });
  if (res.headersSent) {
    // Express will close the connection itself in this case; nothing safe
    // to do beyond logging.
    return;
  }
  res.status(500).json({
    jsonrpc: '2.0',
    error: { code: -32603, message: 'Internal server error' },
    id: null,
  });
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
      `[mcp] Webapp (AS):  ${process.env.WEBAPP_URL ?? 'http://localhost:3000'}\n` +
      `[mcp] Public URL:   ${process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`}\n` +
      `[mcp] Audience:     ${process.env.MCP_AUDIENCE ?? `http://localhost:${PORT}/mcp`}\n`
  );
});
