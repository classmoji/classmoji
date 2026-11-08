/**
 * Links from the slides app back into the webapp. The rule (one route tree per
 * role, built from the server-resolved role) lives in `@classmoji/utils`, which
 * the pages app shares.
 */
export { webappRolePrefix, webappClassPath, webappClassUrl } from '@classmoji/utils/webapp-links';
