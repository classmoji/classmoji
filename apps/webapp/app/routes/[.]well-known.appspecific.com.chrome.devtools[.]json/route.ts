/**
 * Noop route for Chrome DevTools well-known URL
 * Prevents 404 errors when Chrome DevTools probes for this endpoint
 */
export function loader() {
  return new Response('{}', {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
