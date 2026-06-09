#!/usr/bin/env node
// Refuse to boot if any sensitive env var still holds a known placeholder
// or one of the leaked literals that previously shipped in .env.example.

const PLACEHOLDER_PREFIX = 'change-me';

// Old literals that were committed to .env.example prior to remediation.
// Any env value matching these is presumed compromised and must be rotated.
const LEAKED_LITERALS = new Set([
  'g0/GX1zqFKpaOQYHR7SJK6HQXp9cZoEZexXi8kY1EYg=',
  'XQaHNZLhPyKhroSiHpk+hyTTp/6lNx2H1iEKhFxDvM4=',
  '4ukoaO7fdj45abO2uMfVE+362L1r6S64qFWpkbcup/M=',
  '05de7c9de019904155976fa231442d586d3926d16b6e08a43c7e624bf9933982',
]);

const REQUIRED_SECRETS = [
  'BETTER_AUTH_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'CALENDAR_SECRET',
  'AI_AGENT_SHARED_SECRET',
];

let failed = false;

for (const name of REQUIRED_SECRETS) {
  const value = process.env[name];
  if (!value) continue; // missing-secret handling is the app's responsibility
  if (value.startsWith(PLACEHOLDER_PREFIX)) {
    console.error(
      `[check-no-default-secrets] ${name} is still set to a placeholder. Generate a real secret and update your .env.`,
    );
    failed = true;
  }
  if (LEAKED_LITERALS.has(value)) {
    console.error(
      `[check-no-default-secrets] ${name} matches a previously-leaked default. Rotate immediately.`,
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
