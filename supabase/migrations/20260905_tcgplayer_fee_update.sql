-- TCGPlayer raised standard-seller fees: 10.75% marketplace commission + 2.5% + $0.30
-- payment processing, i.e. 13.25% + $0.30 total (previously modeled as a flat 10.25%
-- with no payment-processing component). Fee continues to be computed on listed_price
-- only, not listed_price + shipping_cost -- shipping_cost in this schema represents the
-- seller's own shipping expense (netted out separately in net_listed), not an amount
-- charged to the buyer, matching the existing ebay_listings.ebay_fee convention.
--
-- tcg_fee/net_listed are STORED generated columns, so Postgres won't allow altering
-- their expression in place -- both are dropped and re-added. Every view that selects
-- either column (directly or via a CTE) must be dropped first and recreated after,
-- including v_combined_pnl, which depends on v_tcgplayer_pnl transitively (not on the
-- table/columns directly) but still blocks the DROP VIEW without CASCADE.

DROP VIEW IF EXISTS public.v_combined_pnl;
DROP VIEW IF EXISTS public.v_tcgplayer_pnl_by_game;
DROP VIEW IF EXISTS public.v_tcgplayer_pnl;
DROP VIEW IF EXISTS public.v_tcgplayer_active;
DROP VIEW IF EXISTS public.v_tcgplayer_sold;

ALTER TABLE public.tcgplayer_listings DROP COLUMN tcg_fee;
ALTER TABLE public.tcgplayer_listings DROP COLUMN net_listed;
ALTER TABLE public.tcgplayer_listings ADD COLUMN tcg_fee numeric(10,2) GENERATED ALWAYS AS (round(((listed_price * 0.1325) + 0.30), 2)) STORED;
ALTER TABLE public.tcgplayer_listings ADD COLUMN net_listed numeric(10,2) GENERATED ALWAYS AS (round(((listed_price - ((listed_price * 0.1325) + 0.30)) - shipping_cost), 2)) STORED;

-- ── Recreate the views dropped above (definitions unchanged otherwise) ───────

CREATE OR REPLACE VIEW public.v_tcgplayer_active AS
 SELECT tl.id,
    tl.title,
    tl.card_id,
    tl.listed_price,
    tl.shipping_cost,
    tl.condition,
    tl.quantity,
    tl.notes,
    tl.tcgplayer_url,
    tl.listed_at,
    tl.status,
    tl.cost_basis,
    tl.tcg_fee,
    tl.net_listed,
    c.name AS card_name,
    c.set_name,
    c.rarity,
    c.foil,
    COALESCE(c.game_id, max(c2.game_id::text)::uuid) AS game_id,
    lp.tcgplayer_market AS tcg_market_price,
    string_agg((c2.name ||
        CASE
            WHEN (tlc.quantity > 1) THEN (' ×'::text || tlc.quantity)
            ELSE ''::text
        END), ', '::text ORDER BY c2.name) AS all_card_names,
    COALESCE(sum(tlc.quantity), (0)::bigint) AS card_count,
    (tl.quantity * COALESCE(sum(tlc.quantity), 1)) AS total_quantity
   FROM ((((tcgplayer_listings tl
     LEFT JOIN cards c ON ((c.id = tl.card_id)))
     LEFT JOIN v_latest_prices lp ON ((lp.card_id = tl.card_id)))
     LEFT JOIN tcgplayer_listing_cards tlc ON ((tlc.listing_id = tl.id)))
     LEFT JOIN cards c2 ON ((c2.id = tlc.card_id)))
  WHERE (tl.status = 'active'::text)
  GROUP BY tl.id, tl.title, tl.card_id, tl.listed_price, tl.shipping_cost, tl.condition, tl.quantity, tl.notes, tl.tcgplayer_url, tl.listed_at, tl.status, tl.cost_basis, tl.tcg_fee, tl.net_listed, c.name, c.set_name, c.rarity, c.foil, c.game_id, lp.tcgplayer_market;

CREATE OR REPLACE VIEW public.v_tcgplayer_sold AS
 SELECT tl.id,
    tl.title,
    tl.listed_price,
    tl.shipping_cost,
    tl.quantity,
    tl.sold_price,
    tl.sold_shipping,
    tl.sold_fee,
    tl.cost_basis,
    tl.net_profit,
    tl.sold_at,
    tl.listed_at,
    tl.condition,
    tl.notes,
    tl.tcgplayer_url,
    tl.card_id,
    (EXTRACT(day FROM (tl.sold_at - tl.listed_at)))::integer AS days_to_sell,
    c.name AS card_name,
    c.set_name,
    c.rarity,
    c.foil,
    COALESCE(c.game_id, max(lc_cards.game_id::text)::uuid) AS game_id,
    COALESCE(string_agg(DISTINCT lc_cards.name, ', '::text ORDER BY lc_cards.name) FILTER (WHERE (lc_cards.name IS NOT NULL)), c.name) AS all_card_names,
    COALESCE(count(DISTINCT tlc.card_id) FILTER (WHERE (tlc.card_id IS NOT NULL)), (
        CASE
            WHEN (tl.card_id IS NOT NULL) THEN 1
            ELSE 0
        END)::bigint) AS card_count,
    (tl.quantity * COALESCE(sum(tlc.quantity), 1)) AS total_quantity
   FROM (((tcgplayer_listings tl
     LEFT JOIN cards c ON ((c.id = tl.card_id)))
     LEFT JOIN tcgplayer_listing_cards tlc ON ((tlc.listing_id = tl.id)))
     LEFT JOIN cards lc_cards ON ((lc_cards.id = tlc.card_id)))
  WHERE (tl.status = 'sold'::text)
  GROUP BY tl.id, tl.title, tl.listed_price, tl.shipping_cost, tl.quantity, tl.sold_price, tl.sold_shipping, tl.sold_fee, tl.cost_basis, tl.net_profit, tl.sold_at, tl.listed_at, tl.condition, tl.notes, tl.tcgplayer_url, tl.card_id, c.name, c.set_name, c.rarity, c.foil, c.game_id
  ORDER BY tl.sold_at DESC;

CREATE OR REPLACE VIEW public.v_tcgplayer_pnl AS
 SELECT COALESCE(sum(sold_price) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_revenue,
    COALESCE(sum(sold_fee) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_tcg_fees,
    COALESCE(sum(sold_shipping) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_shipping_paid,
    COALESCE(sum(cost_basis) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_cogs,
    COALESCE(sum(net_profit) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_net_profit,
    count(*) FILTER (WHERE (status = 'active'::text)) AS active_listings_count,
    COALESCE(sum(listed_price) FILTER (WHERE (status = 'active'::text)), (0)::numeric) AS active_listings_gmv,
    COALESCE(sum(net_listed) FILTER (WHERE (status = 'active'::text)), (0)::numeric) AS active_listings_net_if_sold,
    count(*) FILTER (WHERE (status = 'sold'::text)) AS total_sold,
    count(*) AS total_listings
   FROM tcgplayer_listings;

CREATE OR REPLACE VIEW public.v_tcgplayer_pnl_by_game AS
 WITH listing_game AS (
   SELECT tl.id,
      tl.status,
      tl.sold_price,
      tl.sold_fee,
      tl.sold_shipping,
      tl.cost_basis,
      tl.net_profit,
      tl.listed_price,
      tl.net_listed,
      COALESCE(c.game_id, max(c2.game_id::text)::uuid) AS game_id
     FROM (((tcgplayer_listings tl
       LEFT JOIN cards c ON ((c.id = tl.card_id)))
       LEFT JOIN tcgplayer_listing_cards tlc ON ((tlc.listing_id = tl.id)))
       LEFT JOIN cards c2 ON ((c2.id = tlc.card_id)))
    GROUP BY tl.id, tl.status, tl.sold_price, tl.sold_fee, tl.sold_shipping, tl.cost_basis, tl.net_profit, tl.listed_price, tl.net_listed, c.game_id
 )
 SELECT game_id,
    COALESCE(sum(sold_price) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_revenue,
    COALESCE(sum(sold_fee) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_tcg_fees,
    COALESCE(sum(sold_shipping) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_shipping_paid,
    COALESCE(sum(cost_basis) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_cogs,
    COALESCE(sum(net_profit) FILTER (WHERE (status = 'sold'::text)), (0)::numeric) AS total_net_profit,
    count(*) FILTER (WHERE (status = 'active'::text)) AS active_listings_count,
    COALESCE(sum(listed_price) FILTER (WHERE (status = 'active'::text)), (0)::numeric) AS active_listings_gmv,
    COALESCE(sum(net_listed) FILTER (WHERE (status = 'active'::text)), (0)::numeric) AS active_listings_net_if_sold,
    count(*) FILTER (WHERE (status = 'sold'::text)) AS total_sold,
    count(*) AS total_listings
   FROM listing_game
  WHERE (game_id IS NOT NULL)
  GROUP BY game_id;

GRANT ALL ON TABLE public.v_tcgplayer_active TO anon;
GRANT ALL ON TABLE public.v_tcgplayer_active TO authenticated;
GRANT ALL ON TABLE public.v_tcgplayer_active TO service_role;
GRANT ALL ON TABLE public.v_tcgplayer_sold TO anon;
GRANT ALL ON TABLE public.v_tcgplayer_sold TO authenticated;
GRANT ALL ON TABLE public.v_tcgplayer_sold TO service_role;
GRANT ALL ON TABLE public.v_tcgplayer_pnl TO anon;
GRANT ALL ON TABLE public.v_tcgplayer_pnl TO authenticated;
GRANT ALL ON TABLE public.v_tcgplayer_pnl TO service_role;
GRANT ALL ON TABLE public.v_tcgplayer_pnl_by_game TO anon;
GRANT ALL ON TABLE public.v_tcgplayer_pnl_by_game TO authenticated;
GRANT ALL ON TABLE public.v_tcgplayer_pnl_by_game TO service_role;

CREATE OR REPLACE VIEW public.v_combined_pnl AS
 SELECT
    (eb.total_revenue + tc.total_revenue) AS total_revenue,
    eb.total_ebay_fees,
    tc.total_tcg_fees,
    (eb.total_ebay_fees + tc.total_tcg_fees) AS total_fees,
    (eb.total_shipping_paid + tc.total_shipping_paid) AS total_shipping_paid,
    (eb.total_cogs + tc.total_cogs) AS total_cogs,
    (eb.total_net_profit + tc.total_net_profit) AS total_net_profit,
    (eb.active_listings_count + tc.active_listings_count) AS active_listings_count,
    (eb.active_listings_gmv + tc.active_listings_gmv) AS active_listings_gmv,
    (eb.active_listings_net_if_sold + tc.active_listings_net_if_sold) AS active_listings_net_if_sold,
    (eb.total_sold + tc.total_sold) AS total_sold,
    (eb.total_listings + tc.total_listings) AS total_listings
   FROM public.v_global_pnl eb, public.v_tcgplayer_pnl tc;

GRANT ALL ON TABLE public.v_combined_pnl TO anon;
GRANT ALL ON TABLE public.v_combined_pnl TO authenticated;
GRANT ALL ON TABLE public.v_combined_pnl TO service_role;
