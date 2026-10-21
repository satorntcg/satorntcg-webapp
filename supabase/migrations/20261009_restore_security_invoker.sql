-- Restores security_invoker on views that lost it to CREATE OR REPLACE VIEW.
--
-- CREATE OR REPLACE VIEW without a WITH (...) clause resets the view's options; it does
-- NOT keep the existing security_invoker setting. So 20261007_fast_latest_prices.sql
-- silently turned it off for v_latest_prices and v_inventory_dashboard, and
-- 20261009_box_views_direct_latest_price.sql did the same for v_box_pnl. All three are
-- granted to anon, so they ran with owner rights and bypassed RLS for anyone holding
-- the anon key (box purchase prices/sellers/notes, box-derived cost basis).
--
-- Any future CREATE OR REPLACE VIEW must include WITH (security_invoker = true).
-- Check with:
--   SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relkind = 'v'
--     AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false);

ALTER VIEW public.v_latest_prices       SET (security_invoker = true);
ALTER VIEW public.v_inventory_dashboard SET (security_invoker = true);
ALTER VIEW public.v_box_pnl             SET (security_invoker = true);
