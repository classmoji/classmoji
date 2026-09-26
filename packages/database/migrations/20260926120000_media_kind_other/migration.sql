-- Media accepts any file with an extension (decision §7.10: Pro routes video,
-- and anything over the repository's REST ceiling, to R2 — whatever it is).
-- Extensions the store has a type for keep their kind; every other one is
-- OTHER, stored and served as application/octet-stream (a download).
--
-- ADD VALUE only: no existing row changes kind. Postgres cannot use a value
-- added by ALTER TYPE inside the same transaction, and nothing here does.
ALTER TYPE "MediaKind" ADD VALUE 'OTHER';
