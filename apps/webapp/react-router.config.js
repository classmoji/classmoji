/** @type {import('@react-router/dev/config').Config} */
export default {
  ssr: true,
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
