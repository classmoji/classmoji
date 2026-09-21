# hook-station

Fastify webhook listener for GitHub, Stripe and Resend. It verifies each delivery's signature, maps it to a Trigger.dev task, and returns 200 fast; the work happens in `packages/tasks`. It never talks to the browser and has no UI.

Routes (all under `/webhooks/callback`): `src/routes/github.ts`, `src/routes/stripe.ts` (subscriptions), `src/routes/resend.ts` (email bounces, so a public form response whose magic link never arrived is not mistaken for an abandoned one).

## GitHub events

Handlers are keyed `${X-GitHub-Event}.${action}` because GitHub reuses action words (`created`, `deleted`) across unrelated events. `push` has no action and is routed on the event name alone.

| Event | What it does |
|-------|--------------|
| `push` on a student repo | Default branch only; bots and branch deletions ignored. Triggers `webhook-git_repo_push_handler` → `ClassmojiService.gitRepoAssignment.recordPush`, which stamps `closed_at` on every published `REPO`-mode submission for that repo (before the deadline plus purchased extensions; frozen once graded). |
| `push` on a classroom content repo | Triggers `content-assets-sync` to refresh the classroom's path → SHA map (pages, slides). |
| `issues.closed` | `ISSUE`-mode submission: records the submission time. |
| `issues.reopened` | Un-submits (clears `closed_at`). |
| `issues.deleted` | Marks the submission's issue as deleted. |
| `organization.member_added` | Roster sync for a new org member. |
| `installation.created` / `deleted` | Records or clears the classroom's GitHub App installation. |
| `installation.suspend` / `unsuspend` | A suspended installation exists but mints no tokens. |

Pushes and `ISSUE`-mode events only affect `GitRepoAssignment` rows (the submission, unique per git repo + assignment). Autograding results arrive separately, through Trigger.dev's public API (`ingest_autograde_result`), not through this service.

## Local development

GitHub cannot reach localhost, so deliveries come through a smee.io channel:

```bash
npm run hook:dev      # start the listener on port 4000
npm run hook:github   # smee tunnel → http://localhost:4000/webhooks/callback/github
npm run hook:stripe   # same for Stripe
```

The channel URL is the one `apps/webapp/app/routes/setup/manifest.ts` puts in a localhost-created App (`SMEE_WEBHOOK_URL` overrides it). `GITHUB_WEBHOOK_SECRET` must match the App's webhook secret or every delivery is rejected with 401.

## GitHub App requirements

The App must subscribe to `push`, `issues` and `organization` (`default_events` in `setup/manifest.ts`) and hold `contents`, `issues`, `members`, `metadata` and `workflows: write` (the App commits the autograding workflow to student repos).

An App created before push submission mode existed was subscribed to `issues` and `organization` only. Add `push` by hand in the App's settings on GitHub (Permissions & events → Subscribe to events), otherwise `REPO`-mode assignments never record a submission.
