// Health check endpoint for the slides service
export const loader = async () => {
  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'slides',
      timestamp: new Date().toISOString(),
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
