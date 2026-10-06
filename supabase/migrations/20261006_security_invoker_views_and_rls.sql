-- Fixes Supabase database-linter errors 0010 (security_definer_view) and
-- 0013 (rls_disabled_in_public), plus two over-broad anon write policies the
-- linter doesn't flag.
--
-- 1. Views: every public view ran with its owner's (postgres) rights, which
--    bypasses RLS. Since anon has SELECT on all of them by default, anyone
--    holding the anon key (it ships in the client bundle) could read
--    v_global_pnl, v_tcgplayer_orders, v_box_pnl, etc. security_invoker makes
--    each view apply the querying role's RLS instead. Logged-in pages are
--    unaffected (every underlying table has an authenticated policy); the
--    public pages (Home, PublicCards, CardDetail) still work because they only
--    read v_inventory_dashboard / v_price_gainers_losers, whose base tables
--    (cards, price_snapshots, active ebay_listings) have anon SELECT policies.
--    For anon, v_latest_prices' box-derived cost basis now falls back to
--    cards.cost_basis since pack_cards/packs/boxes are authenticated-only.
--
-- 2. document_chunks: only read via match_documents from the rules-ai edge
--    function using the service role key, which bypasses RLS — so enabling RLS
--    with no policies just closes direct anon/authenticated REST access.
--
-- 3. "anon update cards" / "anon insert snapshots" / "anon update snapshots"
--    let anyone with the anon key rewrite inventory and prices. Nothing uses
--    them: the Apps Script price pipeline, daily_price_check, and the MCP
--    server all authenticate with the service role key, and the app's own
--    writes run as authenticated.

ALTER VIEW public.v_active_alerts           SET (security_invoker = true);
ALTER VIEW public.v_box_pnl                 SET (security_invoker = true);
ALTER VIEW public.v_combined_pnl            SET (security_invoker = true);
ALTER VIEW public.v_ebay_active             SET (security_invoker = true);
ALTER VIEW public.v_ebay_pnl_by_game        SET (security_invoker = true);
ALTER VIEW public.v_ebay_sold               SET (security_invoker = true);
ALTER VIEW public.v_global_pnl              SET (security_invoker = true);
ALTER VIEW public.v_inventory_dashboard     SET (security_invoker = true);
ALTER VIEW public.v_latest_prices           SET (security_invoker = true);
ALTER VIEW public.v_listing_price_alerts    SET (security_invoker = true);
ALTER VIEW public.v_pack_pnl                SET (security_invoker = true);
ALTER VIEW public.v_price_gainers_losers    SET (security_invoker = true);
ALTER VIEW public.v_price_highs             SET (security_invoker = true);
ALTER VIEW public.v_price_history           SET (security_invoker = true);
ALTER VIEW public.v_stale_listings          SET (security_invoker = true);
ALTER VIEW public.v_tcgplayer_active        SET (security_invoker = true);
ALTER VIEW public.v_tcgplayer_orders        SET (security_invoker = true);
ALTER VIEW public.v_tcgplayer_pnl           SET (security_invoker = true);
ALTER VIEW public.v_tcgplayer_pnl_by_game   SET (security_invoker = true);
ALTER VIEW public.v_tcgplayer_sold          SET (security_invoker = true);
ALTER VIEW public.v_unrealized_gain_alerts  SET (security_invoker = true);
ALTER VIEW public.v_youtube_opening_summary SET (security_invoker = true);

ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon update cards"     ON public.cards;
DROP POLICY IF EXISTS "anon insert snapshots" ON public.price_snapshots;
DROP POLICY IF EXISTS "anon update snapshots" ON public.price_snapshots;
