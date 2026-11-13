import { actionOriginHosts } from './actionOrigins.js';

/** @type {import('@react-router/dev/config').Config} */
export default {
  ssr: true,
  // The public host whose form submissions (document and `.data` actions) are
  // accepted. Fly terminates TLS and react-router-serve does not trust
  // X-Forwarded-Proto, so `request.url` is `http://<host>` while the browser
  // sends `Origin: https://<host>`; React Router compares scheme too, and
  // without this list every action behind Fly answers 400. Set per image at
  // build time (see actionOrigins.js): app.classmoji.io unless the build sets
  // ACTION_ORIGIN_HOSTS (the staging image: staging.classmoji.io). Local
  // development needs no entry: there the two agree.
  allowedActionOrigins: actionOriginHosts(process.env.ACTION_ORIGIN_HOSTS, 'app.classmoji.io'),
  // Uploads the build's source maps to Sentry, then deletes every .map file so
  // none is served. Only with SENTRY_AUTH_TOKEN (see vite.config.js); without
  // it the build is unchanged.
  ...(process.env.SENTRY_AUTH_TOKEN?.trim() && {
    buildEnd: async args => {
      const { sentryOnBuildEnd } = await import('@sentry/react-router/vite');
      await sentryOnBuildEnd(args);
    },
  }),
};
