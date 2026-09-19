-- Correlate a verification send to the response it belongs to, so a bounce can
-- be traced back to a person instead of being an anonymous provider event.
--
-- STRICTLY ADDITIVE. Three nullable columns and one index: nothing is dropped,
-- nothing is renamed, no default is backfilled, and no existing row changes.
-- Every send made before this migration simply has NULLs, which every read path
-- treats as "we never heard" — the same thing it will say for a send whose
-- provider webhook is not configured yet.
ALTER TABLE "form_magic_tokens"
  ADD COLUMN "provider_message_id" TEXT,
  ADD COLUMN "delivery_state" TEXT,
  ADD COLUMN "delivery_detail" TEXT;

-- The webhook's only lookup key. Deliberately NOT unique: a provider retry
-- carries the same message id, and a redelivered bounce must be an idempotent
-- no-op rather than a constraint violation that answers 500 and gets retried
-- forever.
CREATE INDEX "form_magic_tokens_provider_message_id_idx"
  ON "form_magic_tokens"("provider_message_id");
