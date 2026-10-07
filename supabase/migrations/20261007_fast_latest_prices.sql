-- Speeds up v_latest_prices and v_inventory_dashboard, which every price-aware page
-- (Inventory, Dashboard, CardDetail, Boxes, BoxEV, both listing pages) reads.
--
-- 1. v_latest_prices' latest_snapshot CTE did DISTINCT ON (card_id) over the whole of
--    price_snapshots (~350k rows and growing daily), sorting every snapshot on every
--    query no matter how few cards were asked for. A LATERAL ... ORDER BY checked_at
--    DESC LIMIT 1 per card uses idx_snapshots_card_time (card_id, checked_at DESC)
--    instead: one index probe per card, and only for the cards the outer query keeps.
--
-- 2. v_inventory_dashboard wrapped everything in DISTINCT ON (c.id) ... ORDER BY c.id.
--    Both joins are already one row per card, so it removed nothing — but it stopped
--    Postgres pushing .eq('game_id', ...) down into the view, so every 1000-row page
--    Inventory.jsx/Dashboard.jsx fetch recomputed prices for every card in every game.
--    Callers all order explicitly (.order('name')), so dropping the ORDER BY is safe.
--
-- Column lists/types are unchanged, so CREATE OR REPLACE works and keeps
-- security_invoker = true (see 20261006_security_invoker_views_and_rls.sql).

CREATE OR REPLACE VIEW public.v_latest_prices AS
 WITH box_cost AS (
         SELECT pc.card_id,
            round((sum((b.purchase_price / (b.pack_count)::numeric / 15.0) * (pc.quantity)::numeric) / sum(pc.quantity)), 4) AS avg_cost_basis
           FROM ((public.pack_cards pc
             JOIN public.packs pk ON ((pk.id = pc.pack_id)))
             JOIN public.boxes b ON ((b.id = pk.box_id)))
          WHERE ((b.purchase_price IS NOT NULL) AND (b.pack_count > 0))
          GROUP BY pc.card_id
        )
 SELECT c.id AS card_id,
    c.name,
    c.set_name,
    c.rarity,
    c.foil,
    c.game_id,
    c.tcgplayer_id,
    ls.tcgplayer_market,
    ls.tcgplayer_low,
    ls.ebay_sold_avg,
    ls.ebay_sold_low,
    ls.ebay_sold_high,
    ls.ebay_sold_count,
    ls.checked_at,
    COALESCE(bc.avg_cost_basis, c.cost_basis) AS cost_basis,
    ls.tcgplayer_market AS tcg_market_price
   FROM ((public.cards c
     LEFT JOIN LATERAL ( SELECT ps.tcgplayer_market,
            ps.tcgplayer_low,
            ps.ebay_sold_avg,
            ps.ebay_sold_low,
            ps.ebay_sold_high,
            ps.ebay_sold_count,
            ps.checked_at
           FROM public.price_snapshots ps
          WHERE (ps.card_id = c.id)
          ORDER BY ps.checked_at DESC
         LIMIT 1) ls ON (true))
     LEFT JOIN box_cost bc ON ((bc.card_id = c.id)));

CREATE OR REPLACE VIEW public.v_inventory_dashboard AS
 SELECT c.id,
    c.name,
    c.set_name,
    c.set_code,
    c.rarity,
    c.condition,
    c.foil,
    c.game_id,
    c.tcgplayer_id,
    c.image_url,
    c.notes,
    c.quantity_owned,
    c.quantity_listed,
    (c.quantity_owned - COALESCE(c.quantity_listed, 0)) AS quantity_available,
    c.created_at,
    c.updated_at,
    lp.tcgplayer_market,
    lp.tcgplayer_low,
    lp.ebay_sold_avg,
    lp.ebay_sold_low,
    lp.ebay_sold_high,
    lp.ebay_sold_count,
    lp.checked_at AS price_checked_at,
    lp.cost_basis,
    round((COALESCE(lp.tcgplayer_market, (0)::numeric) * (c.quantity_owned)::numeric), 2) AS market_value,
        CASE
            WHEN ((lp.tcgplayer_market IS NOT NULL) AND (lp.cost_basis IS NOT NULL)) THEN round((lp.tcgplayer_market - lp.cost_basis), 4)
            ELSE NULL::numeric
        END AS unrealized_pnl_per_card,
        CASE
            WHEN ((lp.tcgplayer_market IS NOT NULL) AND (lp.cost_basis IS NOT NULL)) THEN round(((lp.tcgplayer_market - lp.cost_basis) * (c.quantity_owned)::numeric), 2)
            ELSE NULL::numeric
        END AS unrealized_pnl,
    COALESCE(el.active_listing_count, (0)::bigint) AS active_listing_count,
    el.lowest_listed_price,
    c.card_type
   FROM ((public.cards c
     LEFT JOIN public.v_latest_prices lp ON ((lp.card_id = c.id)))
     LEFT JOIN ( SELECT ebay_listings.card_id,
            count(*) AS active_listing_count,
            min(ebay_listings.listed_price) AS lowest_listed_price
           FROM public.ebay_listings
          WHERE (ebay_listings.status = 'active'::text)
          GROUP BY ebay_listings.card_id) el ON ((el.card_id = c.id)));
