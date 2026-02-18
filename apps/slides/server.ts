import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { createRequestHandler } from '@react-router/express';
import compression from 'compression';
import morgan from 'morgan';
import prisma from '@classmoji/database';
import { auth } from '@classmoji/auth/server';

// Helper to get session from socket cookie header
async function getSocketAuthSession(cookieHeader: string) {
  // Create a mock Request object with the cookie header for Better Auth
  const mockHeaders = new Headers();
  mockHeaders.set('cookie', cookieHeader);

  // Try BetterAuth's getSession
  const session = await auth.api.getSession({ headers: mockHeaders });

  if (session?.user) {
    // Get user with classroom memberships
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      include: { classroom_memberships: { include: { classroom: true } } },
    });
    return user;
  }

  // Fallback: Direct DB lookup for dev test sessions
  if (process.env.NODE_ENV === 'development') {
    const sessionTokenMatch = cookieHeader.match(/classmoji\.session_token=([^;]+)/);
    const tokenFromCookie = sessionTokenMatch?.[1];

    if (tokenFromCookie) {
      const tokenOnly = tokenFromCookie.split('.')[0];
      const directSession = await prisma.session.findUnique({
        where: { token: tokenOnly },
        include: { user: true },
      });

      if (directSession?.user && directSession.expires_at > new Date()) {
        const user = await prisma.user.findUnique({
          where: { id: directSession.user.id },
          include: { classroom_memberships: { include: { classroom: true } } },
        });
        return user;
      }
    }
  }

  return null;
}

const app = express();
const httpServer = createServer(app);

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO Setup (works in BOTH dev and prod)
// ─────────────────────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'development'
      ? ['http://localhost:6500', 'http://localhost:3000']
      : [process.env.SLIDES_URL, process.env.WEBAPP_URL].filter(Boolean) as string[],
    credentials: true,
  },
});

// Type for socket data
interface SocketData {
  user?: {
    id: string;
    login: string;
    classroom_memberships: Array<{
      role: string;
      classroom: { id: string; slug: string };
    }>;
  };
  slideId?: string;
  canBroadcast?: boolean;
  shareCode?: string; // For unauthenticated follow-only connections
}

// Authenticate using Better Auth session cookie
// Also supports unauthenticated connections with valid shareCode
io.use(async (socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie || '';

    // Check for shareCode in query params (for public follow links)
    const shareCode = socket.handshake.query.shareCode as string | undefined;

    if (shareCode) {
      // Allow unauthenticated connection with shareCode - will be validated on join
      (socket.data as SocketData).shareCode = shareCode;
      return next();
    }

    const user = await getSocketAuthSession(cookieHeader);

    if (!user) {
      return next(new Error('UNAUTHENTICATED'));
    }

    (socket.data as SocketData).user = user as SocketData['user'];
    return next();
  } catch (err) {
    console.error('[socket] Auth error:', err);
    return next(new Error('UNAUTHENTICATED'));
  }
});

// Multiplex namespace for slide sync
const multiplex = io.of('/multiplex');

// Track current slide position per room for late joiners to catch up
interface RoomState {
  indexh: number;
  indexv: number;
  fragmentIndex?: number;
}
const roomStates = new Map<string, RoomState>();

// Same auth middleware for namespace
multiplex.use(async (socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie || '';

    const shareCode = socket.handshake.query.shareCode as string | undefined;

    if (shareCode) {
      (socket.data as SocketData).shareCode = shareCode;
      return next();
    }

    const user = await getSocketAuthSession(cookieHeader);

    if (!user) {
      return next(new Error('UNAUTHENTICATED'));
    }

    (socket.data as SocketData).user = user as SocketData['user'];
    return next();
  } catch (err) {
    console.error('[multiplex] Auth error:', err);
    return next(new Error('UNAUTHENTICATED'));
  }
});

multiplex.on('connection', (socket) => {
  const data = socket.data as SocketData;
  console.log(`[multiplex] ${data.user?.login || 'anonymous'} connected`);

  socket.on('join', async ({ slideId }: { slideId: string }) => {
    try {
      const slide = await prisma.slide.findUnique({
        where: { id: slideId },
        include: { classroom: true },
      });

      if (!slide) {
        console.log(`[multiplex] Slide ${slideId} not found`);
        return;
      }

      // Check authorization
      if (data.shareCode) {
        // Validate shareCode against slide's multiplex_id
        if (slide.multiplex_id !== data.shareCode) {
          console.log(`[multiplex] Invalid shareCode for slide ${slideId}`);
          socket.emit('error', { message: 'Invalid share code' });
          return;
        }
        // Public follower - can join but not broadcast
        data.canBroadcast = false;
      } else if (data.user) {
        // Authenticated user - verify classroom membership
        const membership = data.user.classroom_memberships.find(
          (m) => String(m.classroom?.id) === String(slide.classroom_id)
        );

        if (!membership) {
          console.log(`[multiplex] User ${data.user.login} not a member of classroom ${slide.classroom_id}`);
          return;
        }

        data.canBroadcast = membership.role === 'OWNER' || membership.role === 'TEACHER';
      } else {
        // No auth at all
        return;
      }

      socket.join(slideId);
      data.slideId = slideId;

      console.log(`[multiplex] ${data.user?.login || 'anonymous'} joined ${slideId} (canBroadcast: ${data.canBroadcast})`);

      // Send current slide position to late joiner (catch-up)
      const currentState = roomStates.get(slideId);
      if (currentState) {
        console.log(`[multiplex] Sending current state to late joiner: h=${currentState.indexh}, v=${currentState.indexv}`);
        socket.emit('currentstate', currentState);
      }

      // Broadcast updated viewer count
      const room = multiplex.adapter.rooms.get(slideId);
      const viewerCount = room ? room.size : 0;
      multiplex.to(slideId).emit('viewercount', { count: viewerCount });
    } catch (err) {
      console.error('[multiplex] Join error:', err);
    }
  });

  socket.on('slidechanged', (eventData: { indexh: number; indexv: number }) => {
    if (!data.canBroadcast || !data.slideId) return;
    // Store current position for late joiners
    roomStates.set(data.slideId, { indexh: eventData.indexh, indexv: eventData.indexv });
    socket.to(data.slideId).emit('slidechanged', eventData);
  });

  socket.on('fragmentshown', (eventData: { index: string; indexh: number; indexv: number }) => {
    if (!data.canBroadcast || !data.slideId) return;
    socket.to(data.slideId).emit('fragmentshown', eventData);
  });

  socket.on('fragmenthidden', (eventData: { index: string; indexh: number; indexv: number }) => {
    if (!data.canBroadcast || !data.slideId) return;
    socket.to(data.slideId).emit('fragmenthidden', eventData);
  });

  // Remote QR display control (speaker view can trigger QR on presenter screen)
  socket.on('showqr', (eventData: { type: 'follow' | 'speaker' }) => {
    if (!data.canBroadcast || !data.slideId) return;
    socket.to(data.slideId).emit('showqr', eventData);
  });

  socket.on('hideqr', () => {
    if (!data.canBroadcast || !data.slideId) return;
    socket.to(data.slideId).emit('hideqr');
  });

  socket.on('disconnect', () => {
    console.log(`[multiplex] ${data.user?.login || 'anonymous'} disconnected`);

    // Broadcast updated viewer count when someone leaves
    if (data.slideId) {
      const room = multiplex.adapter.rooms.get(data.slideId);
      const viewerCount = room ? room.size : 0;
      multiplex.to(data.slideId).emit('viewercount', { count: viewerCount });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Health check endpoint (used by Fly.io to detect unhealthy machines)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[health] DB check failed:', err);
    res.status(503).json({ status: 'error', message: 'database unreachable' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Chrome DevTools well-known URL (noop to prevent 404 errors)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/.well-known/appspecific/com.chrome.devtools.json', (_req, res) => {
  res.json({});
});

// ─────────────────────────────────────────────────────────────────────────────
// React Router: Dev vs Prod
// ─────────────────────────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
  // ═══════════════════════════════════════════════════════════════════════════
  // DEVELOPMENT: Vite in middleware mode (HMR works!)
  // ═══════════════════════════════════════════════════════════════════════════
  const vite = await import('vite');
  const viteDevServer = await vite.createServer({
    server: { middlewareMode: true },
  });

  app.use(viteDevServer.middlewares);

  app.use(async (req, res, next) => {
    try {
      const source = await viteDevServer.ssrLoadModule('./server/app.ts');
      return await source.app(req, res, next);
    } catch (error) {
      if (error instanceof Error) {
        viteDevServer.ssrFixStacktrace(error);
      }
      next(error);
    }
  });

} else {
  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCTION: Serve pre-built assets
  // ═══════════════════════════════════════════════════════════════════════════
  app.use(compression());
  app.disable('x-powered-by');
  app.use(morgan('tiny'));

  // Immutable fingerprinted assets (1 year cache)
  app.use(
    '/assets',
    express.static('build/client/assets', {
      immutable: true,
      maxAge: '1y',
    })
  );

  // Other static files (1 hour cache)
  app.use(express.static('build/client', { maxAge: '1h' }));

  // React Router request handler
  const build = await import('./build/server/index.js');
  app.use(createRequestHandler({ build }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 6500;

httpServer.listen(PORT, () => {
  console.log(`🎭 Slides server running at http://localhost:${PORT} (${isDev ? 'dev' : 'prod'})`);
});

export { io };
