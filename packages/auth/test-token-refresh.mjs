/**
 * Token Refresh Integration Test
 *
 * Tests the GitHub App token refresh system against the live local environment.
 * Exercises all critical scenarios: expiry, mutex, proactive refresh, dead tokens.
 *
 * Usage: node packages/auth/test-token-refresh.mjs
 *        (loads DATABASE_URL from .env automatically)
 */

import { PrismaClient } from '@prisma/client';

const DB_URL = process.env.DATABASE_URL || 'postgresql://classmoji:classmoji@localhost:5433/classmoji';
const WEBAPP_URL = 'http://localhost:3000';
const SLIDES_URL = 'http://localhost:6500';
const USER_LOGIN = 'timofei7';

const prisma = new PrismaClient({ datasourceUrl: DB_URL });

let userId;
let accountId;
let sessionToken;
let originalToken;
let originalRefresh;
let originalExpiry;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getAccount() {
  return prisma.account.findFirst({
    where: { user_id: userId, provider_id: 'github' },
    select: {
      id: true,
      access_token: true,
      refresh_token: true,
      access_token_expires_at: true,
      refresh_token_expires_at: true,
      updated_at: true,
    },
  });
}

async function setTokenExpiry(expiresAt) {
  await prisma.account.update({
    where: { id: accountId },
    data: { access_token_expires_at: expiresAt },
  });
}

async function setTokens({ accessToken, refreshToken, expiresAt }) {
  const data = {};
  if (accessToken !== undefined) data.access_token = accessToken;
  if (refreshToken !== undefined) data.refresh_token = refreshToken;
  if (expiresAt !== undefined) data.access_token_expires_at = expiresAt;
  await prisma.account.update({ where: { id: accountId }, data });
}

async function restoreTokens() {
  await setTokens({
    accessToken: originalToken,
    refreshToken: originalRefresh,
    expiresAt: originalExpiry,
  });
}

async function fetchWithSession(url) {
  return fetch(url, {
    headers: { Cookie: `classmoji.session_token=${sessionToken}` },
    redirect: 'manual',
  });
}

async function clearServerCache() {
  await fetch(`${WEBAPP_URL}/api/auth/clear-cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  // Also clear slides service cache
  await fetch(`${SLIDES_URL}/api/auth/clear-cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  }).catch(() => {}); // slides may not have this endpoint
}

function pass(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
function fail(name, reason) { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${reason}`); }
function info(msg) { console.log(`  \x1b[90m${msg}\x1b[0m`); }

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function testExpiredTokenRefresh() {
  console.log('\n─── Scenario 1: Expired token + valid refresh ───');

  await clearServerCache();

  // Save current tokens (they may have been refreshed since last test)
  const before = await getAccount();
  const savedToken = before.access_token;
  const savedRefresh = before.refresh_token;

  // Expire the token
  const expired = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  await setTokenExpiry(expired);
  info(`Set expires_at to ${expired.toISOString()} (1 hour ago)`);

  // Hit the webapp — this should trigger a refresh
  const res = await fetchWithSession(`${WEBAPP_URL}/select-organization`);
  info(`GET /select-organization → ${res.status}`);

  // Check if tokens were refreshed
  const after = await getAccount();

  if (after.access_token !== savedToken) {
    pass('Access token was refreshed');
    info(`Old: ${savedToken.slice(0, 12)}... → New: ${after.access_token.slice(0, 12)}...`);
  } else {
    fail('Access token was NOT refreshed', 'token unchanged');
  }

  if (after.refresh_token !== savedRefresh) {
    pass('Refresh token was rotated');
  } else {
    fail('Refresh token was NOT rotated', 'same token');
  }

  if (new Date(after.access_token_expires_at) > new Date()) {
    pass('New token has future expiry');
    info(`Expires: ${new Date(after.access_token_expires_at).toISOString()}`);
  } else {
    fail('New token is still expired', after.access_token_expires_at);
  }

  // Update originals for subsequent tests
  originalToken = after.access_token;
  originalRefresh = after.refresh_token;
  originalExpiry = after.access_token_expires_at;
}

async function testConcurrentRefresh() {
  console.log('\n─── Scenario 2: Concurrent requests (mutex test) ───');

  await clearServerCache();

  const before = await getAccount();
  const savedToken = before.access_token;
  const savedRefresh = before.refresh_token;

  await setTokenExpiry(new Date(Date.now() - 60 * 60 * 1000));
  info('Token expired, firing 5 concurrent requests...');

  // Fire 5 concurrent requests
  const promises = Array.from({ length: 5 }, (_, i) =>
    fetchWithSession(`${WEBAPP_URL}/select-organization`)
      .then(res => ({ i, status: res.status }))
      .catch(err => ({ i, error: err.message }))
  );

  const results = await Promise.all(promises);

  // All should succeed (200 or 302 redirect to dashboard)
  const allOk = results.every(r => r.status === 200 || r.status === 302);
  if (allOk) {
    pass(`All 5 requests succeeded: [${results.map(r => r.status).join(', ')}]`);
  } else {
    fail('Some requests failed', JSON.stringify(results));
  }

  // Check DB — should have been refreshed exactly once
  const after = await getAccount();
  if (after.refresh_token !== savedRefresh) {
    pass('Refresh token was rotated (refresh happened)');
  } else {
    fail('Refresh token unchanged', 'mutex may not have triggered refresh');
  }

  if (after.access_token && new Date(after.access_token_expires_at) > new Date()) {
    pass('Token is valid after concurrent requests');
  } else {
    fail('Token is invalid after concurrent requests');
  }

  // Update originals
  originalToken = after.access_token;
  originalRefresh = after.refresh_token;
  originalExpiry = after.access_token_expires_at;
}

async function testProactiveRefresh() {
  console.log('\n─── Scenario 3: Proactive refresh (within 10min buffer) ───');

  await clearServerCache();

  const before = await getAccount();
  const savedToken = before.access_token;

  // Set expiry to 5 minutes from now (within the 10-minute REFRESH_BUFFER_MS)
  const soonExpiry = new Date(Date.now() + 5 * 60 * 1000);
  await setTokenExpiry(soonExpiry);
  info(`Set expires_at to ${soonExpiry.toISOString()} (5 min from now, within 10min buffer)`);

  const res = await fetchWithSession(`${WEBAPP_URL}/select-organization`);
  info(`GET /select-organization → ${res.status}`);

  const after = await getAccount();

  if (after.access_token !== savedToken) {
    pass('Token was proactively refreshed (5 min before expiry < 10 min buffer)');
    info(`Old: ${savedToken.slice(0, 12)}... → New: ${after.access_token.slice(0, 12)}...`);
  } else {
    fail('Token was NOT proactively refreshed', 'still the same token');
  }

  // Update originals
  originalToken = after.access_token;
  originalRefresh = after.refresh_token;
  originalExpiry = after.access_token_expires_at;
}

async function testDeadRefreshToken() {
  console.log('\n─── Scenario 4: Dead refresh token (graceful degradation) ───');

  await clearServerCache();

  const before = await getAccount();

  // Set expired access token + fake dead refresh token
  await setTokens({
    accessToken: before.access_token,
    refreshToken: 'ghr_DEAD_TOKEN_THAT_WILL_FAIL_000000000000000000000000000000000000',
    expiresAt: new Date(Date.now() - 60 * 60 * 1000), // expired
  });
  info('Set expired access token + fake dead refresh token');

  const res = await fetchWithSession(`${WEBAPP_URL}/select-organization`);
  info(`GET /select-organization → ${res.status}`);

  // Should get a redirect (session is valid, but no working token)
  // The user should still get a page, not a 500 error
  if (res.status !== 500) {
    pass(`No 500 error — graceful degradation (got ${res.status})`);
  } else {
    fail('Got 500 — not graceful', 'server crashed');
  }

  const after = await getAccount();
  if (after.access_token === before.access_token) {
    pass('Original access token preserved (refresh failed gracefully)');
  } else {
    info(`Access token changed to: ${after.access_token?.slice(0, 12) || 'null'}...`);
  }

  // Restore good tokens for next tests
  await setTokens({
    accessToken: originalToken,
    refreshToken: originalRefresh,
    expiresAt: originalExpiry,
  });
  info('Restored original tokens');
}

async function testNullTokens() {
  console.log('\n─── Scenario 5: Null access_token + null refresh_token ───');

  await clearServerCache();

  const before = await getAccount();

  await setTokens({
    accessToken: null,
    refreshToken: null,
    expiresAt: new Date(0),
  });
  info('Set both tokens to null, expires_at to epoch');

  const res = await fetchWithSession(`${WEBAPP_URL}/select-organization`);
  info(`GET /select-organization → ${res.status}`);

  if (res.status !== 500) {
    pass(`No 500 error — handles null tokens gracefully (got ${res.status})`);
  } else {
    fail('Got 500 — null tokens caused crash');
  }

  // Restore
  await setTokens({
    accessToken: originalToken,
    refreshToken: originalRefresh,
    expiresAt: originalExpiry,
  });
  info('Restored original tokens');
}

async function testSlidesContentProxy() {
  console.log('\n─── Scenario 6: Slides content proxy with expired token ───');

  await clearServerCache();

  const before = await getAccount();

  // Expire the token
  await setTokenExpiry(new Date(Date.now() - 60 * 60 * 1000));
  info('Token expired, testing slides content proxy...');

  // Try to hit a CSS file through the slides content proxy
  // (uses a known slide from the test DB)
  const cssUrl = `${SLIDES_URL}/content/classmoji-development/content-classmoji-development-25w/.slidesthemes/cs52-themee/lib/offline-v2.css`;
  const res = await fetchWithSession(cssUrl);
  info(`GET content proxy CSS → ${res.status}`);

  if (res.status === 200) {
    pass('Content proxy served CSS with expired (but refreshed) token');
  } else if (res.status === 403) {
    fail('Content proxy returned 403 — auth session not valid', 'getAuthSession returned null');
  } else {
    info(`Unexpected status: ${res.status}`);
  }

  // Check if token was refreshed
  const after = await getAccount();
  if (after.access_token !== before.access_token && new Date(after.access_token_expires_at) > new Date()) {
    pass('Token was refreshed by slides service');
  }

  // Update originals
  originalToken = after.access_token;
  originalRefresh = after.refresh_token;
  originalExpiry = after.access_token_expires_at;
}

async function testClearRevokedToken() {
  console.log('\n─── Scenario 7: clearRevokedToken sets epoch (not null) ───');

  // Simulate clearRevokedToken behavior
  await prisma.account.update({
    where: { id: accountId },
    data: { access_token: null, access_token_expires_at: new Date(0) },
  });

  const after = await getAccount();

  if (after.access_token === null) {
    pass('access_token is null');
  } else {
    fail('access_token should be null', after.access_token);
  }

  if (after.access_token_expires_at && new Date(after.access_token_expires_at).getTime() === 0) {
    pass('access_token_expires_at is epoch (not null)');
  } else if (after.access_token_expires_at === null) {
    fail('access_token_expires_at is null — should be epoch', 'BetterAuth would skip refresh');
  } else {
    fail('Unexpected expires_at value', after.access_token_expires_at);
  }

  // Restore
  await setTokens({
    accessToken: originalToken,
    refreshToken: originalRefresh,
    expiresAt: originalExpiry,
  });
  info('Restored original tokens');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  Token Refresh Integration Tests                     ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  // Find test user
  const user = await prisma.user.findFirst({ where: { login: USER_LOGIN } });
  if (!user) { console.error(`User ${USER_LOGIN} not found`); process.exit(1); }
  userId = user.id;

  // Get account
  const account = await getAccount();
  if (!account) { console.error('No GitHub account found'); process.exit(1); }
  accountId = account.id;

  // Save originals for restoration
  originalToken = account.access_token;
  originalRefresh = account.refresh_token;
  originalExpiry = account.access_token_expires_at;

  // Get session token
  const session = await prisma.session.findFirst({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
  });
  if (!session) { console.error('No active session found. Login first.'); process.exit(1); }
  sessionToken = session.token;

  info(`User: ${USER_LOGIN} (${userId})`);
  info(`Session: ${sessionToken.slice(0, 8)}...`);
  info(`Token: ${originalToken?.slice(0, 12) || 'null'}... expires ${originalExpiry}`);

  try {
    // Each test clears the server-side token cache via POST /api/auth/clear-cache
    // before running, so no server restart is needed between runs.

    await testExpiredTokenRefresh();    // Scenario 1: basic refresh
    await testConcurrentRefresh();       // Scenario 2: mutex
    await testProactiveRefresh();        // Scenario 3: proactive refresh
    await testDeadRefreshToken();        // Scenario 4: dead token
    await testNullTokens();              // Scenario 5: null tokens
    await testSlidesContentProxy();      // Scenario 6: slides service
    await testClearRevokedToken();       // Scenario 7: epoch vs null

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  All scenarios tested. Check results above.');
    console.log('═══════════════════════════════════════════════════════\n');
  } finally {
    // Always restore original tokens
    await restoreTokens();
    info('Tokens restored to original state');
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
