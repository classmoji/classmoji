/**
 * Server-only re-exports for database and service layer.
 *
 * The `.server.js` suffix ensures React Router's Vite plugin
 * completely excludes this module from the client bundle.
 * Without this, importing @classmoji/database or @classmoji/services
 * directly in route files causes a PrismaClient SyntaxError in the browser
 * that prevents React hydration.
 */
export { default as prisma } from '@classmoji/database';
export { ClassmojiService } from '@classmoji/services';
export { getAuthSession } from '@classmoji/auth/server';
