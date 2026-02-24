---
name: commit
description: Create a conventional commit
disable-model-invocation: true
allowed-tools: Bash(git *)
---

Create a conventional commit using the format:
`<type>(<scope>): <subject>`

Types: feat, fix, docs, style, refactor, perf, chore, ci, test

Steps:
1. Run `git status` to see what's changed
2. Run `git diff` to understand the nature of the changes
3. Stage files with `git add .` (gitignore handles exclusions)
4. Analyze the changes to determine the best type, scope, and subject
5. Run `git commit -m "<type>(<scope>): <subject>"`

Rules:
- Subject is lowercase, no period at the end, max 72 chars
- Scope is optional but preferred (e.g. env, auth, webapp, tasks, db)
- `.env.example` is safe to commit — it's a template with no secrets
- Never stage `.env` or `.env.real` — they contain real credentials
- Never use --no-verify
- Never commit directly to main or staging
