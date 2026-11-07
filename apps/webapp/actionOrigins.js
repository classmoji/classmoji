/**
 * The hosts React Router accepts form submissions from when an action's
 * Origin does not match `request.url` (`allowedActionOrigins` in
 * react-router.config.js). Each image lists only its own environment's host:
 * the build reads ACTION_ORIGIN_HOSTS (comma-separated exact host names), which
 * the staging image build sets; production builds use the production host.
 *
 * Strict on purpose: unset, empty, or any entry that is not a plain host name
 * (a wildcard, a scheme, a port, a path, an empty item) falls back to the
 * production host, so a build never ships an empty list or a pattern.
 * Kept identical to apps/slides/actionOrigins.js.
 */
const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * @param {string | undefined} raw ACTION_ORIGIN_HOSTS as the build sees it.
 * @param {string} fallback The production host.
 * @returns {string[]}
 */
export function actionOriginHosts(raw, fallback) {
  const value = (raw ?? '').trim();
  if (!value) return [fallback];
  const hosts = value.split(',').map(host => host.trim().toLowerCase());
  if (hosts.every(host => HOST_NAME.test(host))) return [...new Set(hosts)];
  console.warn(
    `ACTION_ORIGIN_HOSTS=${JSON.stringify(value)} is not a list of host names; using ${fallback}`
  );
  return [fallback];
}
