export default {
  ssr: true,
  // One chunk per route module, as before React Router 8 made splitting the
  // default. No route here exports clientLoader, clientAction,
  // clientMiddleware or HydrateFallback, so today there is nothing to split.
  splitRouteModules: false,
};
