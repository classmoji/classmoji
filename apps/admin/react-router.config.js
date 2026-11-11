export default {
  ssr: true,
  // The Cloudflare Vite plugin builds the Worker through the Vite Environment
  // API. Only for BUILD_TARGET=cloudflare: the Fly build is unchanged.
  ...(process.env.BUILD_TARGET === 'cloudflare' && {
    future: { v8_viteEnvironmentApi: true },
  }),
};
