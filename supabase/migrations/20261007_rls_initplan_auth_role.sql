-- Every "auth_only" policy is USING (auth.role() = 'authenticated'), which Postgres
-- re-evaluates for every row scanned (Supabase linter 0003, auth_rls_initplan).
-- That was harmless while views ran as their owner and bypassed RLS, but since
-- 20261006_security_invoker_views_and_rls.sql the views apply these policies too —
-- so e.g. v_tcgplayer_active -> v_latest_prices' DISTINCT ON over all of
-- price_snapshots (~350k rows) now calls auth.role() once per snapshot row, which
-- is what made the TCGPlayer Listings page slow to load.
--
-- Wrapping the call in a scalar subquery lets the planner evaluate it once per
-- query as an InitPlan. Same semantics, so nothing else changes.
--
-- Rewrites by matching the live policy expression rather than a hard-coded table
-- list, since the live DB has drifted from the migrations before (see
-- 20260919_tcgplayer_orders_rls_fix.sql).

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       -- pg_policies stores an already-wrapped call as "( SELECT auth.role() AS role)",
       -- so skip those to keep this safe to re-run.
       AND ((qual ~ 'auth\.role\(\)' AND qual !~* 'select auth\.role\(\)')
         OR (with_check ~ 'auth\.role\(\)' AND with_check !~* 'select auth\.role\(\)'))
  LOOP
    IF p.qual ~ 'auth\.role\(\)' AND p.qual !~* 'select auth\.role\(\)' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)',
        p.policyname, p.schemaname, p.tablename,
        regexp_replace(p.qual, 'auth\.role\(\)', '(select auth.role())', 'g'));
    END IF;
    IF p.with_check ~ 'auth\.role\(\)' AND p.with_check !~* 'select auth\.role\(\)' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
        p.policyname, p.schemaname, p.tablename,
        regexp_replace(p.with_check, 'auth\.role\(\)', '(select auth.role())', 'g'));
    END IF;
  END LOOP;
END $$;
