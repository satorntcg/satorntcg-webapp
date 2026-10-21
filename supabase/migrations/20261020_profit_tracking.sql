-- Profit page (src/pages/Profit.jsx): real cash profit by month.
--
-- platform_months holds each channel's monthly totals, typed in by hand from the
-- eBay Financial overview and the TCGplayer Sales Summary report (one row per
-- month + platform). expenses holds postage/supplies/other spend that isn't a box
-- purchase. Box spend itself is read straight from boxes.purchase_price.
--
-- Neither table has a game_id: like v_combined_pnl these are whole-account cash
-- figures, since the platform reports don't split by game.

CREATE TABLE IF NOT EXISTS public.platform_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month date NOT NULL,                          -- first day of the month, e.g. 2026-10-01
  platform text NOT NULL CHECK (platform IN ('ebay', 'tcgplayer')),
  gross_sales numeric NOT NULL DEFAULT 0,       -- eBay: Order proceeds | TCGplayer: Net Sales
  refunds numeric NOT NULL DEFAULT 0,           -- eBay: Refunds (positive) | TCGplayer: 0 (already in Net Sales)
  fees numeric NOT NULL DEFAULT 0,              -- eBay: Fees | TCGplayer: Total Fees minus Refunded Fees
  shipping_labels numeric NOT NULL DEFAULT 0,   -- eBay: Shipping labels | TCGplayer: 0
  order_count integer,                          -- TCGplayer: Order Count (drives the postage estimate)
  notes text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (month, platform),
  CHECK (month = date_trunc('month', month)::date)
);

CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spent_at date NOT NULL,
  category text NOT NULL CHECK (category IN ('postage', 'supplies', 'other')),
  amount numeric NOT NULL,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_spent_at ON public.expenses (spent_at);

-- Same authenticated-only policy as every other private table, written in the
-- (select auth.role()) form so it's evaluated once per query (see
-- 20261007_rls_initplan_auth_role.sql). CREATE POLICY has no IF NOT EXISTS, so
-- guard it to keep this file safe to re-run.
ALTER TABLE public.platform_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses        ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'platform_months' AND policyname = 'auth_only'
  ) THEN
    CREATE POLICY auth_only ON public.platform_months USING (((select auth.role()) = 'authenticated'::text));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'expenses' AND policyname = 'auth_only'
  ) THEN
    CREATE POLICY auth_only ON public.expenses USING (((select auth.role()) = 'authenticated'::text));
  END IF;
END $$;

-- Check after applying (both should return one row each):
--   select tablename, policyname, qual from pg_policies
--    where schemaname = 'public' and tablename in ('platform_months', 'expenses');
