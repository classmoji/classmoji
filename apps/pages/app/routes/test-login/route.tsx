// Test-only login route (Playwright harness). Server code lives in the
// co-located .server.ts file so nothing leaks into the client bundle.
export { loader } from './route.server.ts';
