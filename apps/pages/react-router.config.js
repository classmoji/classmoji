/** @type {import('@react-router/dev/config').Config} */
export default {
  ssr: true,
  // Uploads the build's source maps to Sentry, then deletes every .map file so
  // none is served. Only with SENTRY_AUTH_TOKEN (see vite.config.js); without
  // it the build is unchanged.
  ...(process.env.SENTRY_AUTH_TOKEN?.trim() && {
    buildEnd: async args => {
      // Sentry's upload CLI reports its own errors to Sentry unless told not to.
      process.env.SENTRY_CLI_NO_TELEMETRY = '1';
      const { sentryOnBuildEnd } = await import('@sentry/react-router/vite');
      await sentryOnBuildEnd(args);
    },
  }),
};
