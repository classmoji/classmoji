# Playwright E2E Tests

End-to-end tests for the classmoji webapp using Playwright.

## Prerequisites

1. **Dev server running**: Start with `npm run dev` from the monorepo root
2. **Database migrated**: Ensure `npm run db:deploy` has been run
3. **Test data seeded**: Run `npm run db:seed` if needed

## Running Tests

```bash
# From the monorepo root (recommended)
npm run test              # Run all tests across the monorepo
npm run test:ui           # Interactive UI mode
npm run web:test          # Run webapp tests only

# From the webapp directory (apps/webapp)
npx playwright test

# Run specific test suite
npx playwright test owner/dashboard.spec.ts

# Run by project (role)
npx playwright test --project=owner-tests
npx playwright test --project=student-tests
npx playwright test --project=assistant-tests
npx playwright test --project=smoke-tests

# Run in UI mode (interactive)
npx playwright test --ui

# Run with visible browser
npx playwright test --headed

# Debug a specific test
npx playwright test --debug owner/dashboard.spec.ts
```

## Project Structure

```
tests/
├── fixtures/
│   ├── auth.fixture.ts         # Role-based auth fixtures
│   └── mocks/
│       ├── github.mock.ts      # GitHub API mocks
│       ├── llm.mock.ts         # Quiz/LLM API mocks
│       └── stripe.mock.ts      # Payment mocks
├── helpers/
│   ├── auth.helpers.ts         # Cookie creation utilities
│   ├── env.helpers.ts          # Environment/URL helpers
│   └── wait.helpers.ts         # Custom wait utilities
├── auth.setup.ts               # Global auth setup (runs first)
├── owner/                      # Admin/Owner tests
│   └── dashboard.spec.ts
├── assistant/                  # Teaching Assistant tests
│   └── dashboard.spec.ts
├── student/                    # Student tests
│   ├── dashboard.spec.ts
│   └── quizzes.spec.ts
├── smoke/                      # Critical path smoke tests
│   └── critical-paths.spec.ts
└── .auth/                      # Generated auth states (gitignored)
```

## Environment Configuration

Tests automatically read from `.dev-context` to get the correct URLs:

```typescript
import { getDevContext } from './helpers/env.helpers';

const { webappUrl, apiUrl, databaseUrl } = getDevContext();
```

For CI, set environment variables:
- `WEBAPP_URL` - Webapp base URL
- `API_URL` - API base URL
- `GITHUB_PROF_TOKEN` - Auth token for test user

## Test Authentication

Tests use cookie injection to bypass GitHub OAuth:

```typescript
import { test, expect } from '../fixtures/auth.fixture';

test('my test', async ({ authenticatedPage, testUser, testOrg }) => {
  // authenticatedPage already has auth cookie set
  await authenticatedPage.goto(`/admin/${testOrg}/dashboard`);
});
```

### Test User

All tests use `prof-classmoji` (ID: 220514774) who has all 3 roles in `classmoji-development`:
- OWNER
- ASSISTANT
- STUDENT

## Mocking External Services

### GitHub API
```typescript
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';

test.beforeEach(async ({ page }) => {
  await mockGitHubAPI(page);
});
```

### Quiz/LLM API
```typescript
import { mockQuizAPI, mockQuizSSE } from '../fixtures/mocks/llm.mock';

test.beforeEach(async ({ page }) => {
  await mockQuizAPI(page);
  await mockQuizSSE(page);
});
```

### Stripe
```typescript
import { mockStripeAPI } from '../fixtures/mocks/stripe.mock';

test.beforeEach(async ({ page }) => {
  await mockStripeAPI(page);
});
```

## Writing New Tests

1. Create test file in appropriate directory (`owner/`, `student/`, `assistant/`)
2. Import fixtures: `import { test, expect } from '../fixtures/auth.fixture';`
3. Set up mocks in `beforeEach` if needed
4. Use `authenticatedPage` for pre-authenticated page
5. Use `testOrg` for organization name
6. Use `waitForDataLoad()` after navigation

Example:
```typescript
import { test, expect } from '../fixtures/auth.fixture';
import { mockGitHubAPI } from '../fixtures/mocks/github.mock';
import { waitForDataLoad } from '../helpers/wait.helpers';

test.describe('My Feature', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await mockGitHubAPI(page);
    await page.goto(`/admin/${testOrg}/my-feature`);
    await waitForDataLoad(page);
  });

  test('does something', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Expected Text')).toBeVisible();
  });
});
```

## Troubleshooting

### Tests fail with "Cookie not set"
- Ensure `GITHUB_PROF_TOKEN` is set in your `.env` file
- Check `.dev-context` exists (start dev server first)

### Tests fail with "Element not found"
- Increase timeout: `await expect(element).toBeVisible({ timeout: 15000 })`
- Add `waitForDataLoad(page)` after navigation
- Check if element is in a modal or tab that needs to be opened first

### Tests are flaky
- Use `waitForDataLoad()` instead of fixed delays
- Use `expect.poll()` for dynamic content
- Mock external APIs that may be slow/unreliable
