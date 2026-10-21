-- Fixes the Boxes page taking ~67s to load (v_box_pnl), a regression from
-- 20261007_fast_latest_prices.sql.
--
-- The view did LEFT JOIN v_latest_prices lp ON lp.card_id = pc.card_id. Since
-- v_latest_prices became cards LEFT JOIN LATERAL (... LIMIT 1), Postgres can't push
-- pc.card_id into it. Combined with RLS filters that make the planner estimate 1 row
-- per level, it picked a nested loop that rebuilt the latest price for every card
-- (~4.5k) once per pack_cards row (~1.6k): ~7.1M index probes. EXPLAIN ANALYZE as
-- authenticated: 66.8s.
--
-- The view only ever reads lp.tcgplayer_market, so it now looks up the latest snapshot
-- directly per pack_cards row via idx_snapshots_card_time (card_id, checked_at DESC):
-- one probe per row, regardless of planner estimates. Results are identical: one latest
-- price per card, or NULL when it has no snapshot (verified with EXCEPT against the old
-- view: all 41 rows match). Measured ~0.65s.
--
-- v_pack_pnl and v_youtube_opening_summary use the same join but currently get a good
-- plan (~0.2s); switch them to this form if they ever regress.
--
-- Rule of thumb: join v_latest_prices only when the outer side is cards itself
-- (ON lp.card_id = c.id), where the filter pushes down. From any other table's card_id,
-- use a LATERAL lookup like this.
--
-- Column lists/types are unchanged, so CREATE OR REPLACE works. WITH (security_invoker
-- = true) is required: CREATE OR REPLACE resets view options otherwise. (The first
-- applied version lacked it; see 20261009_restore_security_invoker.sql.)

CREATE OR REPLACE VIEW public.v_box_pnl WITH (security_invoker = true) AS
 SELECT b.id,
    b.name,
    b.set_name,
    b.box_type,
    b.purchase_price,
    b.pack_count,
    b.pack_msrp,
    b.purchased_at,
    b.opened_at,
    b.seller,
    b.notes,
    b.game_id,
    count(DISTINCT pk.id) AS packs_opened,
    COALESCE(sum(pc.quantity), 0::bigint) AS cards_pulled,
    count(DISTINCT pc.card_id) AS distinct_cards_pulled,
    COALESCE(sum(lp.tcgplayer_market * pc.quantity::numeric), 0::numeric) + count(DISTINCT pk.id)::numeric * 1.00 AS cards_market_value,
        CASE
            WHEN b.purchase_price IS NOT NULL AND b.pack_count > 0 THEN round(b.purchase_price / b.pack_count::numeric / 15.0, 4)
            ELSE NULL::numeric
        END AS cost_per_card,
    COALESCE(sum(lp.tcgplayer_market * pc.quantity::numeric), 0::numeric) + count(DISTINCT pk.id)::numeric * 1.00 - COALESCE(b.purchase_price, 0::numeric) AS gross_pnl,
        CASE
            WHEN COALESCE(b.purchase_price, 0::numeric) > 0::numeric THEN round((COALESCE(sum(lp.tcgplayer_market * pc.quantity::numeric), 0::numeric) + count(DISTINCT pk.id)::numeric * 1.00 - b.purchase_price) / b.purchase_price * 100::numeric, 1)
            ELSE NULL::numeric
        END AS roi_pct
   FROM public.boxes b
     LEFT JOIN public.packs pk ON pk.box_id = b.id
     LEFT JOIN public.pack_cards pc ON pc.pack_id = pk.id
     LEFT JOIN LATERAL ( SELECT ps.tcgplayer_market
           FROM public.price_snapshots ps
          WHERE ps.card_id = pc.card_id
          ORDER BY ps.checked_at DESC
         LIMIT 1) lp ON true
  GROUP BY b.id, b.name, b.set_name, b.box_type, b.purchase_price, b.pack_count, b.pack_msrp, b.purchased_at, b.opened_at, b.seller, b.notes, b.game_id
  ORDER BY b.purchased_at DESC;
