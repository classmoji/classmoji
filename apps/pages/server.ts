import express from 'express';
import { createRequestHandler } from '@react-router/express';
import compression from 'compression';
import morgan from 'morgan';

import {
  buildSiteLoadContext,
  createSiteHostMiddleware,
  resolveSiteHostConfig,
} from './server/siteHost.ts';
import { createCustomDomainSnapshot } from './server/customDomains.ts';

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// Class-site host handling
// Built once at boot so a malformed SITE_BASE_DOMAIN fails startup, not
// requests. Unset SITE_BASE_DOMAIN ⇒ the rewriter is a no-op.
//
// The custom-domain snapshot is built alongside it and injected as a plain
// closure: siteHost.ts must keep its "no runtime dependencies" property, and
// this is the one place that knows both halves. It starts empty and fills in
// from the database within a second of boot — see server/customDomains.ts for
// why a whole-table snapshot rather than a per-request lookup.
//
// It is built ONLY when the feature is on. With SITE_BASE_DOMAIN unset,
// `resolveSiteRequest` passes on its first line and the map can never be read,
// so constructing it would hold a second Postgres pool open and run a table
// scan every 45 seconds for a result nobody can consult. Resolving the config
// twice is free — it is pure, and its throw-on-malformed-SITE_BASE_DOMAIN keeps
// startup, not requests, as the place that fails.
// ─────────────────────────────────────────────────────────────────────────────
const siteConfig = resolveSiteHostConfig(process.env);
const customDomains = siteConfig.siteBaseDomain ? createCustomDomainSnapshot() : null;

const { sanitizeForwardedHost, rewriteSiteRequests } = createSiteHostMiddleware(
  process.env,
  customDomains ? { resolveCustomHost: customDomains.resolve } : {}
);

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

  // React Router request handler.
  //
  // `getLoadContext` is what carries the custom-domain marker into the loaders.
  // The dev path builds its own handler in server/app.ts and needs the SAME
  // wiring — a marker plumbed into only one of the two entry points is a marker
  // that silently does nothing in the other environment.
  const build = await import('./build/server/index.js');
  app.use(createRequestHandler({ build, getLoadContext: req => buildSiteLoadContext(req) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7100;

app.listen(PORT, () => {
  console.log(`📄 Pages server running at http://localhost:${PORT} (${isDev ? 'dev' : 'prod'})`);
});
