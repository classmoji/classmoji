// React Router's server build, a virtual module its Vite plugin provides.
declare module 'virtual:react-router/server-build' {
  import type { ServerBuild } from 'react-router';
  const build: ServerBuild;
  export = build;
}
