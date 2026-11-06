/** @type {import('@react-router/dev/config').Config} */
export default {
  ssr: true,
  // The public hosts whose form submissions (document and `.data` actions) are
  // accepted. Fly terminates TLS and react-router-serve does not trust
  // X-Forwarded-Proto, so `request.url` is `http://<host>` while the browser
  // sends `Origin: https://<host>`; React Router compares scheme too, and
  // without this list every action behind Fly answers 400. Exact hosts, no
  // wildcards. Local development needs no entry: there the two agree.
  allowedActionOrigins: ['app.classmoji.io', 'staging.classmoji.io'],
  // Uploads the build's source maps to Sentry, then deletes every .map file so
  // none is served. Only with SENTRY_AUTH_TOKEN (see vite.config.js); without
  // it the build is unchanged.
  ...(process.env.SENTRY_AUTH_TOKEN?.trim() && {
    buildEnd: async args => {
      const { sentryOnBuildEnd } = await import('@sentry/react-router');
      await sentryOnBuildEnd(args);
    },
  }),
};
