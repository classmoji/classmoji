# Classmoji MCP — Manual Test Playbook

Copy-pasteable recipes for verifying the MCP server end-to-end without
automated tests. Use this every time you make a non-trivial change to
auth, transport, tool registration, or scope/role filtering.

> **Convention used in this doc**: examples assume the dev webapp listens on
> `:3001` (because `:3000` is often taken by another project on Tim's
> machine) and the MCP server on `:8100`. Adjust `WEBAPP_URL` /
> `MCP_AUDIENCE` if your ports differ.

---

## 0. One-time setup

```bash
# Confirm dev DB is up
cat /Users/tim/Sandbox/classmoji/classmoji/.dev-context
docker ps | grep classmoji-postgres

# Start the webapp (BetterAuth OAuth provider)
cd /Users/tim/Sandbox/classmoji/classmoji
WEBAPP_URL=http://localhost:3001 \
MCP_AUDIENCE=http://localhost:8100/mcp \
MCP_PUBLIC_URL=http://localhost:8100 \
  npm run web:dev > /tmp/claude/classmoji-webdev.log 2>&1 &

# Start the MCP server
cd /Users/tim/Sandbox/classmoji/classmoji/apps/mcp
WEBAPP_URL=http://localhost:3001 \
MCP_AUDIENCE=http://localhost:8100/mcp \
MCP_PUBLIC_URL=http://localhost:8100 \
PORT=8100 \
  node --experimental-strip-types --no-warnings src/index.ts \
  > /tmp/claude/classmoji-mcp.log 2>&1 &

# Wait, then verify both are alive
sleep 8
curl -sS http://localhost:3001/api/auth/jwks | head -c 200
curl -sS http://localhost:8100/health
```

If JWKS returns a `keys` array and `/health` returns `{"ok":true,...}`, you're ready.

---

## 1. Health & metadata smoke test

```bash
echo "=== AS metadata ==="
curl -sS http://localhost:3001/.well-known/oauth-authorization-server \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('issuer:', d['issuer']); print('jwks_uri:', d['jwks_uri']); print('scopes:', len(d['scopes_supported']))"

echo "=== Protected-resource metadata ==="
curl -sS http://localhost:3001/.well-known/oauth-protected-resource

echo "=== JWKS ==="
curl -sS http://localhost:3001/api/auth/jwks | head -c 200

echo "=== MCP protected-resource (advertises AS) ==="
curl -sS http://localhost:8100/.well-known/oauth-protected-resource

echo "=== MCP health ==="
curl -sS http://localhost:8100/health
```

**Expected**: AS metadata has 29 scopes (all our resource scopes + composites + identity).
JWKS returns `EdDSA` key. MCP health returns `{"ok":true,"service":"classmoji-mcp","version":"1.0.0"}`.

---

## 2. Mint a dev JWT (instead of full OAuth flow)

The `/api/dev/mint-jwt` endpoint is enabled in non-production. It creates
JWTs in the same shape oauth-provider issues, so you can test MCP without
walking through DCR + authorize + consent + token exchange.

```bash
# Get a real user_id from the DB
docker exec classmoji-postgres psql -U classmoji -d classmoji -t \
  -c "SELECT id, login FROM users LIMIT 5;"

# Mint a token for timofei7 (admin in dev classroom)
USER_ID="b7f863eb-fb15-48d1-8b49-17683ac4e8a9"      # timofei7
TOKEN=$(curl -sS "http://localhost:3001/api/dev/mint-jwt?user_id=$USER_ID&scope=mcp:full&aud=http://localhost:8100/mcp" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
echo "Token: ${TOKEN:0:60}..."

# Decode the JWT to verify claims
echo "$TOKEN" | python3 -c '
import sys, base64, json
t = sys.stdin.read().strip().split(".")
pad = lambda s: s + "=" * (-len(s) % 4)
print(json.dumps(json.loads(base64.urlsafe_b64decode(pad(t[1]))), indent=2))
'
```

**Expected**: payload contains `sub`, `aud: ["http://localhost:8100/mcp"]`,
`azp: "dev-mint-client"`, `scope: "..."`, `iss:
"http://localhost:3001/api/auth"`, `exp` ~1h out, no `jti` (BetterAuth
doesn't issue jti).

**Common test users in the dev classroom (`classmoji-dev-winter-2025`)**:

| login | user_id | roles |
|-------|---------|-------|
| `timofei7` | `b7f863eb-fb15-48d1-8b49-17683ac4e8a9` | OWNER + ASSISTANT + STUDENT |
| `fake-student-1` | `4682cfc6-ff46-46eb-b998-566b4d0ded88` | STUDENT |
| `fake-ta` | `6380ed5f-b3bb-4ce7-94d9-040720d5028e` | ASSISTANT |

---

## 3. Auth boundary tests (the security-critical bits)

```bash
echo "=== /mcp without Authorization header ==="
# Expect: 401 + WWW-Authenticate header pointing to /.well-known/oauth-protected-resource
curl -sS -i http://localhost:8100/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}},"id":1}' \
  | head -10

echo "=== /mcp with garbage token ==="
# Expect: 401 with "invalid_token" + error_description
curl -sS -i http://localhost:8100/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer garbage.garbage.garbage" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}},"id":1}' \
  | head -10

echo "=== /mcp with wrong audience ==="
# Mint a token with the wrong audience claim — should fail audience check
WRONG_AUD=$(curl -sS "http://localhost:3001/api/dev/mint-jwt?user_id=$USER_ID&scope=mcp:full&aud=http://example.com/wrong" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -sS -i http://localhost:8100/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $WRONG_AUD" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}},"id":1}' \
  | head -10
```

**Expected each**: `HTTP/1.1 401 Unauthorized` + `WWW-Authenticate: Bearer
realm="OAuth", resource_metadata="..."`. Wrong-audience case shows
`error_description="unexpected \"aud\" claim value"`.

---

## 4. Initialize an MCP session + list tools

This is the standard MCP handshake. Used at the start of every session.

```bash
# Helper: open a session, return the session ID (for use with subsequent calls)
mcp_init() {
  local TOKEN=$1
  curl -sS -i http://localhost:8100/mcp -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual-test","version":"1"}},"id":1}' \
    2>&1 | grep -i "mcp-session-id:" | cut -d' ' -f2 | tr -d '\r\n'
}

# Helper: send notifications/initialized to complete the handshake
mcp_initialized() {
  local TOKEN=$1 SID=$2
  curl -sS http://localhost:8100/mcp -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -H "mcp-session-id: $SID" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    > /dev/null
}

# Helper: call a tool
mcp_call() {
  local TOKEN=$1 SID=$2 TOOL=$3 ARGS=$4
  curl -sS http://localhost:8100/mcp -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -H "mcp-session-id: $SID" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS},\"id\":99}"
}

# Use them
SID=$(mcp_init "$TOKEN")
echo "Session: $SID"
mcp_initialized "$TOKEN" "$SID"

# tools/list (count + names)
curl -sS http://localhost:8100/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}' \
  | tail -1 | sed 's/^data: //' | python3 -c "
import sys, json
d = json.load(sys.stdin)
tools = d['result']['tools']
print(f'{len(tools)} tools:')
for t in tools: print(f'  {t[\"name\"]}')
"
```

**Expected counts**:
- timofei7 + `mcp:full` → **24 tools** (admin + teaching team + student + cross + shared)
- timofei7 + `mcp:readonly` → **9 tools** (cross + shared read-only)
- fake-student-1 + `mcp:full` → **10 tools** (cross + shared + student-only)
- fake-ta + `mcp:full` → **11 tools** (cross + shared + teaching team)

---

## 5. Per-tool happy-path tests

After running the helpers in §4 to establish `$TOKEN` and `$SID`:

```bash
echo "=== classrooms_list ==="
mcp_call "$TOKEN" "$SID" "classrooms_list" '{}' | tail -1

echo "=== set_active_classroom ==="
mcp_call "$TOKEN" "$SID" "set_active_classroom" '{"classroomSlug":"classmoji-dev-winter-2025"}' | tail -1

echo "=== assignments_upcoming (no slug — uses session active) ==="
mcp_call "$TOKEN" "$SID" "assignments_upcoming" '{}' | tail -1

echo "=== search_content ==="
mcp_call "$TOKEN" "$SID" "search_content" '{"query":"Hello","classroomSlug":"classmoji-dev-winter-2025"}' | tail -1

echo "=== calendar_ics_url ==="
mcp_call "$TOKEN" "$SID" "calendar_ics_url" '{"classroomSlug":"classmoji-dev-winter-2025"}' | tail -1
# Verify the URL actually fetches a real ICS feed:
URL=$(mcp_call "$TOKEN" "$SID" "calendar_ics_url" '{"classroomSlug":"classmoji-dev-winter-2025"}' \
  | tail -1 | sed 's/^data: //' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["structuredContent"]["url"])')
curl -sS "$URL" | head -3      # Expect: BEGIN:VCALENDAR ...
```

### Write tools — round-trip pattern

```bash
echo "=== modules_write create + delete (round-trip) ==="
CREATED=$(mcp_call "$TOKEN" "$SID" "modules_write" \
  '{"method":"create","classroomSlug":"classmoji-dev-winter-2025","title":"MANUAL TEST","description":"from playbook"}' \
  | tail -1 | sed 's/^data: //' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["structuredContent"]["created"]["id"])')
echo "Created module: $CREATED"

# Verify it actually hit the DB
docker exec classmoji-postgres psql -U classmoji -d classmoji -c \
  "SELECT id, title FROM modules WHERE id = '$CREATED';"

# Clean up
mcp_call "$TOKEN" "$SID" "modules_write" \
  "{\"method\":\"delete\",\"classroomSlug\":\"classmoji-dev-winter-2025\",\"moduleId\":\"$CREATED\"}" \
  | tail -1
```

### Validation tests

```bash
echo "=== modules_write create with missing title (expect InvalidParams) ==="
mcp_call "$TOKEN" "$SID" "modules_write" \
  '{"method":"create","classroomSlug":"classmoji-dev-winter-2025"}' | tail -1
# Expect: "MCP error -32602: create requires title"

echo "=== set_active_classroom with bogus slug (expect Zod enum reject) ==="
mcp_call "$TOKEN" "$SID" "set_active_classroom" '{"classroomSlug":"not-a-real-classroom"}' | tail -1
# Expect: validation error from Zod
```

---

## 6. Role + scope filtering verification

Run these in three separate sessions with different tokens:

```bash
# Faculty (timofei7 has all roles in dev classroom) + mcp:full
TOKEN_FACULTY=$(curl -sS "http://localhost:3001/api/dev/mint-jwt?user_id=b7f863eb-fb15-48d1-8b49-17683ac4e8a9&scope=mcp:full&aud=http://localhost:8100/mcp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# Student-only + mcp:full
TOKEN_STUDENT=$(curl -sS "http://localhost:3001/api/dev/mint-jwt?user_id=4682cfc6-ff46-46eb-b998-566b4d0ded88&scope=mcp:full&aud=http://localhost:8100/mcp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# Faculty token, narrow scope (read-only)
TOKEN_RO=$(curl -sS "http://localhost:3001/api/dev/mint-jwt?user_id=b7f863eb-fb15-48d1-8b49-17683ac4e8a9&scope=mcp:readonly&aud=http://localhost:8100/mcp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

# Compare tool counts:
for label in faculty student ro; do
  case $label in
    faculty) T=$TOKEN_FACULTY;;
    student) T=$TOKEN_STUDENT;;
    ro)      T=$TOKEN_RO;;
  esac
  S=$(mcp_init "$T")
  mcp_initialized "$T" "$S"
  COUNT=$(curl -sS http://localhost:8100/mcp -X POST \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $T" -H "mcp-session-id: $S" \
    -d '{"jsonrpc":"2.0","method":"tools/list","id":2}' \
    | tail -1 | sed 's/^data: //' \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))')
  echo "$label: $COUNT tools"
done
```

**Expected**: `faculty: 24` / `student: 10` / `ro: 9`.

---

## 7. Full OAuth flow (replaces dev-mint when you want to test the real path)

End-to-end DCR + authorize + consent + token. This validates the real OAuth
provider plus the consent UI.

### 7a. Browser-based (most realistic)

1. Sign into the webapp at `http://localhost:3001/` with a GitHub user.
2. In a new browser session or curl, register a test client:
   ```bash
   curl -sS -X POST http://localhost:3001/api/auth/oauth2/register \
     -H "Content-Type: application/json" \
     -d '{
       "client_name": "Manual Test",
       "redirect_uris": ["http://localhost:9999/cb"],
       "grant_types": ["authorization_code", "refresh_token"],
       "response_types": ["code"],
       "scope": "openid profile email mcp:full offline_access",
       "token_endpoint_auth_method": "none"
     }' | python3 -m json.tool
   ```
   Note the returned `client_id`.
3. Build PKCE pair:
   ```bash
   CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | head -c 43)
   CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr -d '=' | tr '/+' '_-')
   echo "verifier: $CODE_VERIFIER"
   echo "challenge: $CODE_CHALLENGE"
   ```
4. Visit (in browser, while logged in):
   ```
   http://localhost:3001/api/auth/oauth2/authorize?client_id=<CLIENT_ID>&response_type=code&redirect_uri=http://localhost:9999/cb&scope=openid+profile+email+mcp:full+offline_access&state=teststate&code_challenge=<CODE_CHALLENGE>&code_challenge_method=S256&resource=http://localhost:8100/mcp
   ```
5. **First time**: consent screen renders. Verify:
   - Scope rollup shows family-level rows ("Assignments readwrite" etc.)
   - Click **Authorize**.
6. Browser redirects to `http://localhost:9999/cb?code=<CODE>&state=teststate&iss=...`.
   Connection refused is fine — copy `code` from URL.
7. Exchange:
   ```bash
   curl -sS -X POST http://localhost:3001/api/auth/oauth2/token \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=authorization_code&code=<CODE>&code_verifier=$CODE_VERIFIER&redirect_uri=http://localhost:9999/cb&client_id=<CLIENT_ID>&resource=http://localhost:8100/mcp" \
     | python3 -m json.tool
   ```
   Should return `access_token`, `refresh_token`, `id_token`.
8. Use the access token against MCP exactly like in §4-§5.

### 7b. Verify in Connected Apps UI

Visit `http://localhost:3001/settings/connected-apps`. You should see "Test
OAuth Client" (or whatever `client_name` you registered) with the granted
scopes. Click **Disconnect** and verify the row disappears.

---

## 8. Cleanup

```bash
# Kill MCP
lsof -ti :8100 | xargs kill 2>/dev/null

# Kill webapp dev
pkill -f "react-router dev"

# Clean test rows
docker exec classmoji-postgres psql -U classmoji -d classmoji -c "
  DELETE FROM modules WHERE title LIKE 'MANUAL TEST%' OR title LIKE 'MCP Test%';
  DELETE FROM oauth_clients WHERE name LIKE 'Manual Test%' OR name LIKE 'Test OAuth%';
"
```

---

## 9. Things to check after non-trivial changes

| Change | Re-run sections |
|--------|-----------------|
| `apps/mcp/src/auth/*` | §3 (auth boundary), §6 (filtering) |
| `apps/mcp/src/tools/<file>` | §5 happy-path for that tool family |
| `apps/mcp/src/index.ts` (transport / Express) | §0, §3, §4 |
| `apps/mcp/src/server.ts` (factory / registration) | §4 (tool count), §6 (filtering) |
| `packages/auth/src/server.ts` (BetterAuth config) | §1 (metadata), §7 (OAuth flow) |
| `apps/webapp/app/routes/oauth.consent/...` | §7 (consent UI) |
| `apps/webapp/app/routes/_user.settings.connected-apps/...` | §7b |
| `packages/database/schema.prisma` | re-run migration, then full §0-§5 |

## 10. Logs to check

| Log | What it tells you |
|-----|-------------------|
| `/tmp/claude/classmoji-webdev.log` | Webapp + BetterAuth errors. `[Better Auth]:` lines are the most useful. |
| `/tmp/claude/classmoji-mcp.log` | MCP server startup + per-session events (`mcp.session.opened`, `mcp.session.closed`). |
| `docker logs classmoji-postgres` | DB-level errors (rare). |

---

## Recipes for common failure modes

**`Cannot find package 'X' imported from @better-auth/Y`** — workspace
hoisting issue. `npm install --workspace=apps/webapp X`, restart webapp,
clear `apps/webapp/node_modules/.vite/`.

**`Model X does not exist in the database`** — Prisma client out of sync.
Run `cd /Users/tim/Sandbox/classmoji/classmoji && npx prisma generate
--schema packages/database/schema.prisma`, restart webapp.

**`requested resource invalid` on `/oauth2/token`** — RFC 8707 audience
mismatch. Check `MCP_AUDIENCE` env var matches what's in the BetterAuth
`validAudiences` allowlist (`packages/auth/src/server.ts`).

**JWT verifies in `dev-mint` but fails on MCP** — issuer mismatch. The dev
mint sets `iss = ${WEBAPP_URL}/api/auth`. The MCP validator expects
`${process.env.WEBAPP_URL}/api/auth`. If those differ (e.g. webapp ran on
:3000 but mcp env says :3001), tokens won't validate. Restart both with
matching `WEBAPP_URL`.

**MCP shows stub error after I implemented a tool** — MCP server didn't
reload. It's a plain Node process, no HMR. `lsof -ti :8100 | xargs kill`,
restart with the same env vars.
