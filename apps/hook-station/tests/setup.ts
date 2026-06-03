// Set webhook secrets BEFORE any route module is imported. github.ts reads
// GITHUB_WEBHOOK_SECRET at module-load top level and throws if it's missing,
// so this must run before any (even static) import of that route.
process.env.GITHUB_WEBHOOK_SECRET = 'test-gh-secret';
