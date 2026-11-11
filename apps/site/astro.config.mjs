import { defineConfig } from 'astro/config';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'url';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import node from '@astrojs/node';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { createInlineSvgUrl } from '@astrojs/starlight/expressive-code';
import starlightThemeBlack from 'starlight-theme-black';
import { satteri } from '@astrojs/markdown-satteri';
import { legacyHeadingIds } from './src/markdown/headingIds.mjs';

// Two builds of the same site:
// - Fly (the default, production today): Astro's Node server, apps/site/Dockerfile.
// - Cloudflare Workers (BUILD_TARGET=cloudflare; staging today): the
//   @astrojs/cloudflare adapter, which is NOT in package.json. It is installed
//   on top of a standalone copy of the site by cloudflare/install.sh (see
//   there for why), so this file loads it only in that branch, and the Fly
//   build never resolves it. CLOUDFLARE_ENV picks the wrangler.jsonc
//   environment at build time (dev, staging).
const isCloudflare = process.env.BUILD_TARGET === 'cloudflare';
const cloudflareEnv = isCloudflare ? process.env.CLOUDFLARE_ENV ?? '' : '';
const cloudflareAdapter = isCloudflare ? (await import('@astrojs/cloudflare')).default : null;

/**
 * Cloudflare builds only: /health (version id for CI's smoke check) and, on
 * staging, a noindex header on every static file, appended to
 * dist/client/_headers. The adapter PREPENDS its immutable /_astro/* rule to
 * that file in its own astro:build:done, so the two hooks may run in either
 * order; cloudflare/check-build.mjs asserts both rules. The 404 page the
 * Worker serves comes from the static files too, so it gets the header from
 * this rule (src/middleware.ts covers what the Worker renders itself).
 */
function cloudflareSite() {
  let clientDir;
  return {
    name: 'classmoji:cloudflare-site',
    hooks: {
      'astro:config:setup': ({ injectRoute }) => {
        injectRoute({
          pattern: '/health',
          entrypoint: './src/cloudflare/health.ts',
          prerender: false,
        });
      },
      'astro:config:done': ({ config }) => {
        clientDir = config.build.client; // dist/client: the static files and _headers
      },
      'astro:build:done': async () => {
        if (cloudflareEnv !== 'staging') return;
        const headersPath = new URL('./_headers', clientDir);
        const existing = await readFile(headersPath, 'utf8').catch(() => '');
        const rule = '/*\n  X-Robots-Tag: noindex\n';
        await writeFile(headersPath, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${rule}`);
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  // The canonical origin, for every build (staging's copy points crawlers at
  // the real page): canonical links and og:url on every page, and Starlight's
  // sitemap (dist/client/sitemap-index.xml).
  site: 'https://classmoji.io',
  // Pages are pre-built and served as files; only the contact form
  // (/api/contact) runs code on the server. src/middleware.ts turns off the
  // unused image and island routes Astro adds to any site with an adapter
  // (/_image, /_server-islands/*). bodySizeLimit caps request bodies. The
  // contact form's largest post is about 50 KB: every field at its maxlength
  // in 3-byte characters, URL-encoded by a browser without JavaScript (the
  // page's own script posts multipart, about 17 KB at most). The contact route
  // caps its body at the same size itself, which is the only cap on Workers.
  //
  // Cloudflare: pages prerender in Node at build time (as on Fly; the Worker
  // only runs /api/contact and /health), images are optimized at build time,
  // and there are no sessions (otherwise the adapter adds a KV binding).
  adapter: isCloudflare
    ? cloudflareAdapter({ prerenderEnvironment: 'node', imageService: 'compile' })
    : node({ mode: 'standalone', bodySizeLimit: 64 * 1024 }),
  ...(isCloudflare ? { session: false } : {}),
  // Astro 7 strips whitespace the JSX way by default ('jsx'), which glues
  // together inline elements in our templates (nav links, footer links, post
  // bylines). Keep the HTML-aware compression the site was written for.
  compressHTML: true,
  // Astro's default Markdown processor, plus heading ids that stay the same as
  // before Astro 7 so existing links to headings keep working (headingIds.mjs).
  // Starlight adds its own plugins to this processor.
  // Keep @astrojs/markdown-satteri in package.json at the exact version astro
  // pins internally (0.4.6 for astro 7.4.5) and move the two together;
  // otherwise this processor and astro's own come from different copies.
  markdown: {
    processor: satteri({ hastPlugins: [legacyHeadingIds()] }),
  },
  security: {
    // Fly's proxy talks to the server over http. allowedDomains lets Astro
    // trust the Host and X-Forwarded-Proto it forwards for classmoji.io, so the
    // request URL is https://classmoji.io/... and checkOrigin can compare a form
    // post's Origin with it.
    allowedDomains: [{ hostname: 'classmoji.io', protocol: 'https' }],
    checkOrigin: true,
  },
  integrations: [
    starlight({
      title: '🍎 classmoji',
      description: 'Documentation for Classmoji - the git-native LMS for CS education',
      // The site's (and the app's) icon. Starlight's default is /favicon.svg,
      // which the site does not have, so the docs pages had no icon.
      favicon: '/favicon.ico',
      // These keep the docs looking as they did with starlight-theme-black 0.6
      // (with src/styles/docs-classic.css): the header with "Back to main site"
      // and the small-screen bottom-sheet menu, the breadcrumb title without
      // the arrows, the sidebar with "New" badges, the full-width footer bar
      // with the Privacy and Terms links, chevron previous/next links and the
      // sun/moon theme switch. Head is Starlight's own, without the theme's
      // preloads of fonts the docs do not use.
      components: {
        Head: './src/components/docs/Head.astro',
        SiteTitle: './src/components/docs/SiteTitle.astro',
        PageTitle: './src/components/docs/PageTitle.astro',
        Sidebar: './src/components/docs/Sidebar.astro',
        PageFrame: './src/components/docs/PageFrame.astro',
        Pagination: './src/components/docs/Pagination.astro',
        ThemeSelect: './src/components/docs/ThemeSelect.astro',
      },
      plugins: [
        // Header links live in src/components/docs/navLinks.ts: our SiteTitle
        // and Drawer render them, not the theme.
        starlightThemeBlack({
          docs: { showMarkdownActions: false },
        }),
      ],
      sidebar: [
        {
          label: '👋 Introduction',
          items: [
            { label: 'Welcome', slug: 'docs' },
            { label: 'Getting started', slug: 'docs/introduction/getting-started' },
            { label: 'Core concepts', slug: 'docs/introduction/fundamentals' },
            {
              label: 'Video tutorials',
              slug: 'docs/video-tutorials',
              badge: { text: 'New', variant: 'tip' },
            },
          ],
        },
        {
          label: '👨‍🏫 For Instructors',
          items: [
            { label: 'Create a classroom', slug: 'docs/instructors/create-classroom' },
            {
              label: 'Github Classroom',
              slug: 'docs/instructors/import-github-classroom',
              badge: { text: 'New', variant: 'tip' },
            },
            { label: 'Manage your roster', slug: 'docs/instructors/roster' },
            { label: 'Repositories', slug: 'docs/instructors/repositories' },
            { label: 'Modules & assignments', slug: 'docs/instructors/modules-and-assignments' },
            {
              label: 'Autograding',
              slug: 'docs/instructors/autograding',
              badge: { text: 'New', variant: 'tip' },
            },
            { label: 'Build pages', slug: 'docs/instructors/pages' },
            { label: 'Build modules', slug: 'docs/instructors/modules' },
            {
              label: 'Class website',
              slug: 'docs/instructors/class-sites',
              badge: { text: 'New', variant: 'tip' },
            },
            {
              label: 'Custom domain',
              slug: 'docs/instructors/custom-domains',
              badge: { text: 'New', variant: 'tip' },
            },
            { label: 'Grade assignments', slug: 'docs/instructors/grading' },
            { label: 'Configure tokens', slug: 'docs/instructors/tokens' },
            {
              label: 'Ask Moji',
              slug: 'docs/instructors/ask-moji',
              badge: { text: 'New', variant: 'tip' },
            },
            {
              label: 'MCP server setup',
              slug: 'docs/instructors/mcp-server',
              badge: { text: 'New', variant: 'tip' },
            },
          ],
        },
        {
          label: '🎒 For Students',
          items: [
            { label: 'Join a classroom', slug: 'docs/students/join-a-classroom' },
            { label: 'Submit assignments', slug: 'docs/students/submit-assignments' },
            { label: 'Use tokens', slug: 'docs/students/use-tokens' },
            { label: 'View grades', slug: 'docs/students/view-grades' },
          ],
        },
        {
          label: '🐳 Self-hosting',
          items: [
            { label: 'Deploy with Docker', slug: 'docs/self-hosting/docker' },
            { label: 'Environment variables', slug: 'docs/self-hosting/environment-variables' },
          ],
        },
        {
          label: '🌐 Open Source',
          items: [
            { label: 'Local development', slug: 'docs/open-source/local-development' },
            { label: 'Github repo', link: 'https://github.com/classmoji/classmoji' },
            { label: 'Roadmap', link: 'https://github.com/orgs/classmoji/projects/2' },
          ],
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'Github',
          href: 'https://github.com/classmoji/classmoji',
        },
      ],
      customCss: [
        './src/styles/docs-classic.css',
        './src/styles/starlight.css',
      ],
      // Code blocks as starlight-theme-black 0.6 set them up. Theme 0.7 picks
      // other code themes and frame colours; undefined hands those settings
      // back to Expressive Code's defaults, as 0.6 left them.
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          codeBackground: 'var(--code-background)',
          borderWidth: '0px',
          borderRadius: 'calc(var(--radius) + 4px)',
          gutterBorderWidth: '0px',
          borderColor: undefined,
          gutterBorderColor: undefined,
          frames: {
            editorBackground: 'var(--code-background)',
            terminalBackground: 'var(--code-background)',
            copyIcon: createInlineSvgUrl(
              '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path></svg>',
            ),
            shadowColor: undefined,
            editorTabBarBackground: undefined,
            editorActiveTabBackground: undefined,
            editorActiveTabIndicatorTopColor: undefined,
            editorTabBarBorderColor: undefined,
            editorActiveTabBorderColor: undefined,
            terminalTitlebarBorderBottomColor: undefined,
            editorTabBarBorderBottomColor: undefined,
            editorActiveTabIndicatorBottomColor: undefined,
          },
          textMarkers: {
            markBackground: 'var(--mark-background)',
            markBorderColor: 'var(--border)',
          },
        },
      },
    }),
    mdx(),
    // React islands: the animated "How it works" demos on the home page.
    react(),
    ...(isCloudflare ? [cloudflareSite()] : []),
  ],
  server: {
    // Round and easy to remember, and clear of every other app: the webapp is
    // on 3000, hook on 4001, slides 6500, pages 7100, admin 7500, collab
    // 7700, MCP 8100, each shifted by `DEVPORT_ID * 10` in a worktree.
    //
    // Not 4000: that is the local webhook fanout the Smee tunnels post to, and
    // a site dev server sitting on it swallows every Github push event.
    // Not under 1024 either, since those need root to bind.
    port: 2000
  },
  vite: {
    plugins: [tailwindcss()],
    // Build-time constants for the server code (declared in src/env.d.ts):
    // which runtime the contact route runs on, and the wrangler environment
    // (only 'staging' adds noindex headers).
    define: {
      __CF_BUILD__: JSON.stringify(isCloudflare),
      __SITE_ENV__: JSON.stringify(cloudflareEnv),
    },
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
        // The Node build has no `cloudflare:workers`; the contact route reads
        // its bindings from it only on Workers.
        ...(isCloudflare
          ? {}
          : { 'cloudflare:workers': fileURLToPath(new URL('./src/cloudflare/workers-stub.ts', import.meta.url)) }),
      },
    },
  }
});