import express from 'express';
import { createRequestHandler } from '@react-router/express';
import compression from 'compression';
import morgan from 'morgan';

const app = express();

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
const PORT = process.env.PORT || 7100;

app.listen(PORT, () => {
  console.log(`📄 Pages server running at http://localhost:${PORT} (${isDev ? 'dev' : 'prod'})`);
});
