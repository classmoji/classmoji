/**
 * Mint a local MCP bearer token for a seeded user and print the Claude Code
 * command that wires it up — one agent session per user.
 *
 *   ./scripts/devport.sh run node --experimental-strip-types \
 *     scripts/collab-dev/mint-mcp-token.ts collab-teacher-1 [hours]
 *
 * Calls the MCP server's dev mint (`POST /dev/mint-token`, registered only
 * when NODE_ENV=development and ENABLE_TEST_LOGIN=true), so the dev stack
 * must be running. The token is a real oauth_access_tokens row; it expires
 * after `hours` (default 12) and is printed once.
 */
import { CLASSROOM_REF } from './constants.ts';

const login = process.argv[2];
const hours = Number(process.argv[3] ?? '12');
if (!login || !Number.isFinite(hours) || hours <= 0) {
  console.error('Usage: mint-mcp-token.ts <github-username> [hours=12]');
  process.exitCode = 2;
} else {
  const base = (process.env.MCP_PUBLIC_URL || 'http://localhost:8110').replace(/\/$/, '');
  const response = await fetch(`${base}/dev/mint-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      login,
      scopes: ['read', 'write'],
      expiresInSeconds: Math.round(hours * 3600),
    }),
  }).catch((error: unknown) => {
    console.error(`Could not reach the MCP server at ${base} — is the dev stack running?`);
    console.error(error instanceof Error ? error.message : error);
    return null;
  });

  if (response && !response.ok) {
    console.error(`Mint failed (${response.status}): ${await response.text()}`);
    if (response.status === 404) {
      console.error('404 = unknown user, or the dev mint is off (needs ENABLE_TEST_LOGIN=true).');
    }
    process.exitCode = 1;
  } else if (response) {
    const minted = (await response.json()) as {
      access_token: string;
      login: string;
      access_token_expires_at: string;
    };
    const name = `classmoji-${minted.login}`;
    console.log(`# MCP token for ${minted.login}, expires ${minted.access_token_expires_at}`);
    console.log(`# Classroom argument for tools: ${CLASSROOM_REF}`);
    console.log('# Add it to Claude Code (run from the directory the agent session will use):');
    console.log(
      `claude mcp add --transport http ${name} ${base}/mcp --header "Authorization: Bearer ${minted.access_token}"`
    );
    console.log(`# Remove later: claude mcp remove ${name}`);
  }
}
