-- eBay listings already returned by the MCP server's find_ebay_deals tool
-- (satorntcg-mcp-server/src/tools/ebayDeals.js), so a later run with only_new=true can
-- hide them unless the price has dropped since.
--
-- Written only by the MCP server, which uses the service role key and so bypasses RLS.
-- RLS is still enabled with the usual authenticated-only policy so the anon key that
-- ships in the app bundle can't read or write it.

CREATE TABLE IF NOT EXISTS public.ebay_deal_seen (
  item_id    text PRIMARY KEY,                    -- eBay Browse API itemId, e.g. v1|1234567890|0
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_price numeric,                             -- buy_total (price/current bid + shipping) when last returned
  card_id    uuid REFERENCES public.cards(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ebay_deal_seen_card ON public.ebay_deal_seen (card_id);

ALTER TABLE public.ebay_deal_seen ENABLE ROW LEVEL SECURITY;

-- (select auth.role()) form so it's evaluated once per query, see
-- 20261007_rls_initplan_auth_role.sql. CREATE POLICY has no IF NOT EXISTS, so guard it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ebay_deal_seen' AND policyname = 'auth_only'
  ) THEN
    CREATE POLICY auth_only ON public.ebay_deal_seen USING (((select auth.role()) = 'authenticated'::text));
  END IF;
END $$;

-- Check after applying (should return one row):
--   select tablename, policyname, qual from pg_policies where tablename = 'ebay_deal_seen';
