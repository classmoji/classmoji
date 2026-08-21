import express from 'express';
import { createRequestHandler } from '@react-router/express';
import compression from 'compression';
import morgan from 'morgan';

import { createSiteHostMiddleware } from './server/siteHost.ts';

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// Class-site host handling
// Built once at boot so a malformed SITE_BASE_DOMAIN fails startup, not
// requests. Unset SITE_BASE_DOMAIN ⇒ the rewriter is a no-op.
// ─────────────────────────────────────────────────────────────────────────────
const { sanitizeForwardedHost, rewriteSiteRequests } = createSiteHostMiddleware(process.env);

// Strip the spoofable X-Forwarded-Host before ANY other middleware can read it
// (@react-router/express honours it when building the request URL).
app.use(sanitizeForwardedHost);

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

  // After vite (site hosts still need /@vite, /@fs and asset URLs unrewritten),
  // before the React Router handler.
  app.use(rewriteSiteRequests);

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
  // Exactly one hop — the Fly proxy. Never `true`.
  app.set('trust proxy', 1);
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

  // After the static handlers (site hosts still need /assets/*), before the
  // React Router handler.
  app.use(rewriteSiteRequests);

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
