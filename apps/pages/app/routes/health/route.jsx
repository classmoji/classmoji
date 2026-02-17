/**
 * Health check endpoint.
 * Returns 200 OK with basic status info.
 */
export const loader = async () => {
  return Response.json({
    status: 'ok',
    service: 'pages',
    timestamp: new Date().toISOString(),
  });
};

const Health = () => {
  return (
    <div style={{ padding: '2rem', fontFamily: 'monospace' }}>
      <h1>Pages Service - Healthy</h1>
    </div>
  );
};

export default Health;
