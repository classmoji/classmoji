# Staging Gitlab on Fly

A self-managed Gitlab for testing Classmoji's self-hosted Gitlab support on
staging. Two or three people sign in to it; everyone else is a fake account.
It is a test box: no backups, no email, no SSH. If it breaks, delete it and
deploy again.

This folder is not an npm workspace and no workflow deploys it. Deploy by hand
from here.

## First deploy

```bash
cd infra/gitlab-staging
fly apps create classmoji-gitlab-staging
fly volumes create gitlab_data --size 5 --region iad -a classmoji-gitlab-staging
fly deploy
```

The first boot takes 5 to 10 minutes. Then open
https://gitlab.classmoji.io and sign in as `root`:

```bash
# deleted 24 hours after the first boot
fly ssh console -a classmoji-gitlab-staging -C "cat /etc/gitlab/initial_root_password"
```

On this instance the admin has since been renamed from `root` to `pape98`
(same account, same password). Change its password, then turn off sign-ups:
Admin > Settings > General >
Sign-up restrictions.

## Between test sessions

```bash
fly machine stop  -a classmoji-gitlab-staging
fly machine start -a classmoji-gitlab-staging   # ready in 3 to 5 minutes
```

A stopped machine costs almost nothing; the 5 GB volume is still billed. If it fills up: `fly volumes extend <id> --size 10 -a classmoji-gitlab-staging` (volumes grow, never shrink).

## Connect it to staging Classmoji

1. In Gitlab, Admin > Applications > New application:
   - Redirect URIs, one per line, with staging's webapp URL:
     `<webapp>/api/auth/gitlab-instance/callback` and
     `<webapp>/connect/gitlab/callback`
   - Scopes: `api`, `read_user`, `read_repository`, `write_repository`
   - Trusted: on
2. On staging Classmoji, open `/gitlab/setup`, enter
   `gitlab.classmoji.io` with the application ID and secret.
3. Approve the instance in staging's admin app.

## Fake accounts

Create a personal access token for the admin (`pape98`) with the `api` scope, then:

```bash
GITLAB=https://gitlab.classmoji.io
TOKEN=glpat-...
for u in aokafor jrivera mchen; do
  curl -s -X POST "$GITLAB/api/v4/users" -H "PRIVATE-TOKEN: $TOKEN" \
    --data "username=$u&name=$u&email=$u@school.test&password=$(openssl rand -hex 12)Aa1!&skip_confirmation=true"
done
```

To act as one of them, use Admin > Users > the user > Impersonate.

## A runner for autograding

Autograding runs as Gitlab CI jobs, so the instance needs a runner. Runners
only connect outward, so a local one works while you test. In Gitlab, Admin >
CI/CD > Runners > New instance runner, copy its token, then:

```bash
docker exec -it classmoji-gitlab-runner gitlab-runner register --non-interactive \
  --url https://gitlab.classmoji.io \
  --token glrt-... \
  --executor docker --docker-image alpine:latest
```

## If it keeps restarting

It is probably out of memory: raise `memory` in `fly.toml` to `"6gb"` and
deploy again.
