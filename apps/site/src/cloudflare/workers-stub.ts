// Stands in for `cloudflare:workers` in the Node (Fly) build and in tests
// (astro.config.mjs aliases it): no bindings, so `env` is empty.
export const env: Record<string, unknown> = {};
