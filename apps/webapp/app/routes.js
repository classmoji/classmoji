import { route } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

export default [
  // BetterAuth - must come before api.$operation to avoid conflict
  route("/api/auth/*", "./routes/api.auth.$.js"),
  // All other routes
  ...(await flatRoutes({
    ignoredRouteFiles: ["**/api.auth.$.js"],
  })),
];
