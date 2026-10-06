-- Clear avatar URLs that point at GitHub's identicon endpoint (issue #374).
--
-- The example classroom seeded its demo personas (and the dev seed scripts
-- their fixture users) with https://github.com/identicons/<login>.png. GitHub
-- answers 404 for those, so every place that showed the persona drew the
-- browser's broken-image icon. With no image, the UI draws the user's
-- initials instead, which is what the example classroom now seeds.
--
-- Data only; no schema change. users.image is what the app displays;
-- accounts.image is the provider profile copy of the same dead URL, cleared
-- with it.
-- ---------------------------------------------------------------------------

UPDATE "users"
SET "image" = NULL
WHERE "image" LIKE 'https://github.com/identicons/%';

UPDATE "accounts"
SET "image" = NULL
WHERE "image" LIKE 'https://github.com/identicons/%';
