# Project gallery

An owner enables the gallery on a form in the Pages app. The Project Showcase
preset assigns fields to the project title, summary, cover, video, team, links,
and details. Students submit the form; owners, teachers, and assistants review
projects in the gallery queue. Only APPROVED, SUBMITTED responses appear on a
class site's `/projects` and `/projects/:responseId` pages. The gallery spans
terms belonging to the same git organization. Editing a submitted project
returns it to PENDING until staff approve it again.

Identity questions, account email, and staff response metadata never appear in
the public projection. Other answered input fields may appear as project
details, so the fill page explicitly discloses publication. Mark private
questions as identity questions. They cannot also have a gallery role.

## Media

Classroom gallery forms offer cover and video uploads when the existing shared
media capability is available: Pro, R2 configured, and signed content delivery
enabled for the classroom. Without that capability, pasted URLs still work.
Public forms accept links; they do not expose student upload endpoints.

Uploads use the shared multipart client and media service. Files go directly
from the browser to R2 through signed part URLs; answers store `media://<id>`.
The service verifies the completed upload's respondent, classroom, form, field,
kind, and READY status before accepting it. The public read repeats ownership
checks and resolves fresh delivery URLs against each project's original
classroom, including projects from older terms.

- Covers: JPG, JPEG, PNG, GIF, WEBP; up to 20 MB.
- Videos: MP4, MOV, WEBM, M4V; up to 250 MB, using the existing video processing job.
- Each respondent: 1 GB and 50 live gallery uploads per classroom, across forms.
- The existing shared classroom quota also applies. Pending reservations count;
  abandoned reservations expire through the existing media lifecycle.

Clearing a field removes its answer reference. It does not delete a file that
could still be used by an approved response. Staff can remove unused uploads
through the existing media management screen.

## Deployment and verification

No new environment variables or storage service are required. Deploy the
`project_gallery` and `gallery_media` migrations before the new app code. The
existing Fly deployment waits for the webapp migration release command before
rolling out Pages.

Before any local database operation, read `.dev-context` and use the worktree's
database. The full services suite can be run with:

```sh
./scripts/devport.sh run npm run test -w @classmoji/services
npm run typecheck -w @classmoji/services
npm run typecheck -w @classmoji/pages
npm run pages:build -w @classmoji/pages
```

The gallery HTTP/browser specs run against the Pages server:

```sh
npx playwright test -c apps/pages/playwright.config.ts \
  apps/pages/tests/e2e/forms-gallery-media.spec.ts \
  apps/pages/tests/e2e/forms-gallery-gate.spec.ts \
  apps/pages/tests/e2e/forms-gallery-moderation.spec.ts \
  apps/pages/tests/e2e/forms-gallery-switch.spec.ts \
  apps/pages/tests/unit/forms-showcase-preset.spec.ts
```

The media browser scenario needs a media-capable local server. Its upload
requests are intercepted, and its database row is disposable fixture metadata;
it writes no cloud object. For that scenario, start Pages with synthetic R2 and
signing values after loading the local environment:

```sh
npx dotenv -e .env -- ./scripts/devport.sh run env \
  PORT=7110 MEDIA_R2_ACCOUNT_ID=gallery-local-test \
  MEDIA_R2_ACCESS_KEY_ID=gallery-local-test MEDIA_R2_SECRET_ACCESS_KEY=gallery-local-test \
  MEDIA_R2_BUCKET=gallery-local-test CONTENT_SIGNING_SECRET=gallery-local-test \
  CONTENT_DELIVERY_ORIGIN=http://localhost:7110 npm run pages:dev -w @classmoji/pages
```

Replace `7110` with the Pages port in `.dev-context`; stop the normal Pages
process first. A real R2 upload and production video conversion remain a
post-deployment smoke check. The shared media service's mocked R2 tests verify
multipart completion, size checks, quota locking, and processing behavior.

Light and dark upload screenshots are in `docs/screenshots/`.
