import { clientIpHeader } from '@classmoji/utils';

/**
 * The client IP of a request: the platform's header in production
 * (Fly-Client-IP on Fly, CF-Connecting-IP on Workers; written by the proxy,
 * not forgeable, see `clientIpHeader`), else the first X-Forwarded-For entry
 * (local dev).
 */
export function clientIp(headers: Headers | undefined): string | null {
  if (!headers) return null;
  const platform = headers.get(clientIpHeader());
  if (platform) return platform.trim();
  if (process.env.NODE_ENV === 'production') return null;
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}
