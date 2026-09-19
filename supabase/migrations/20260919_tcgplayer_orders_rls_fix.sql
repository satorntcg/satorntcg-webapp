-- The auth_only policy for tcgplayer_orders/tcgplayer_order_items defined in
-- 20260906_tcgplayer_orders.sql was never actually present on the live database
-- (confirmed via `select * from pg_policies where tablename = 'tcgplayer_orders'`
-- returning zero rows on 2026-09-19) -- schema drift between this repo's migration
-- history and the real database, cause unknown.
--
-- Effect: v_tcgplayer_orders (owned by postgres, which bypasses RLS) could still be
-- read fine, so the Orders tab displayed data normally. But direct UPDATEs against
-- the tcgplayer_orders table -- as done by Tcgplayerlistings.jsx's toggleOrderStatus
-- and the Sold-modal auto-promote-to-shipped side effect -- ran as the 'authenticated'
-- role against a table with RLS enabled and zero policies, which default-denies every
-- row. No error is raised; the UPDATE just silently matches zero rows. This is exactly
-- the "order status not updating" bug reported 2026-09-19.
--
-- CREATE POLICY has no IF NOT EXISTS, so guard against re-running this against an
-- environment where the policy does already exist (e.g. dev/staging that never drifted).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tcgplayer_orders' AND policyname = 'auth_only'
  ) THEN
    CREATE POLICY auth_only ON public.tcgplayer_orders USING ((auth.role() = 'authenticated'::text));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tcgplayer_order_items' AND policyname = 'auth_only'
  ) THEN
    CREATE POLICY auth_only ON public.tcgplayer_order_items USING ((auth.role() = 'authenticated'::text));
  END IF;
END $$;
