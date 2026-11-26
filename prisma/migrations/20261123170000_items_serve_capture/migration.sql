-- items.external_ids and items.source_meta are served on the keyed tier
-- (/v1/items, the `keyed` block), so a change to either now counts as a change
-- to what the API serves and moves items.updated_at.
--
-- This replaces the items_set_updated_at() function from 064 with the same
-- bookkeeping list minus those two columns. contributors stays on the list: no
-- API shape serves it. Run this BEFORE the backfills that rewrite these
-- columns on existing rows, or accept that each such row moves once.
-- Idempotent. After re-running 063 or 064, run this file again.

CREATE OR REPLACE FUNCTION items_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bookkeeping CONSTANT text[] := ARRAY[
    'updated_at', 'shuffle_key', 'search_text', 'harmonized_at', 'rules_version',
    'source_verified_at', 'review_flags', 'human_reviewed_at',
    'master_dims_checked_at', 'accent_color_status', 'phash', 'curator_boost',
    'vibe_note', 'contributors'
  ];
BEGIN
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - bookkeeping) THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;

-- Verify:
--   SELECT prosrc LIKE '%external_ids%' FROM pg_proc
--     WHERE proname = 'items_set_updated_at';  -- false
