/**
 * Which JavaScript runtime this code is running on.
 *
 * Classmoji services run on Node (Fly, Trigger.dev) and, one by one, on
 * Cloudflare Workers (workerd). Code that must behave differently between the
 * two asks here, never by sniffing request headers: a header can be sent by
 * anyone, the runtime cannot.
 */

/**
 * True on Cloudflare Workers. workerd sets `navigator.userAgent` to exactly
 * `Cloudflare-Workers`; Node 21+ has a `navigator` too, with `Node.js/<v>`.
 * Read at call time, so tests can stub `navigator`.
 */
export function isWorkerd(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers'
  );
}

/**
 * The request header that carries the real client IP, written by the platform
 * in front of the service and never forwarded from the client:
 * - Cloudflare Workers: `cf-connecting-ip` (set by Cloudflare's edge).
 * - Fly: `fly-client-ip` (set by Fly's proxy).
 *
 * Chosen by the runtime, never by which header happens to be present: a client
 * can send `CF-Connecting-IP` to a Fly host (classmoji's records are grey-cloud,
 * so nothing in front of Fly strips it), so Fly must only ever trust
 * `Fly-Client-IP`.
 */
export function clientIpHeader(): 'cf-connecting-ip' | 'fly-client-ip' {
  return isWorkerd() ? 'cf-connecting-ip' : 'fly-client-ip';
}
