/**
 * The largest request body the MCP server accepts — Fastify's `bodyLimit`.
 *
 * Its own module, with no imports, because two places need the same number:
 * `index.ts` hands it to Fastify, and `page_asset_upload` derives its file cap
 * from it (a tool cap above what the body can carry would never get to fire —
 * Fastify would answer a bare 413 first, with no MCP error in it).
 *
 * Bigger than Fastify's 1 MiB default, because two tools accept payloads that
 * dwarf it and enforce their own ceilings — with a reason the caller can act
 * on. The Streamable HTTP transport is handed the ALREADY-PARSED body (see
 * routes/mcp.ts), so this limit is the only one on the path.
 *
 * 8 MiB, because page_asset_upload carries file BYTES as base64, which inflates
 * them by a third; form_response_create's batch caps at 2 MB. Not raised to
 * follow the repository's 35 MB file cap: base64 through a tool call makes the
 * model emit every character, so it is only practical for small files anyway.
 */
export const MCP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
