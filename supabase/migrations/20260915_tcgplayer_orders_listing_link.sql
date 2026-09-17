-- Surfaces tcgplayer_orders (populated via the Gmail-based order sync, see
-- 20260906_tcgplayer_orders.sql) in the TCGPlayer Listings page, and lets listing rows
-- show a "real order pending/shipped" badge for their card(s).
--
-- Matching is card_id-only by design: tcgplayer_order_items.card_id is only populated
-- when card_name_raw was successfully matched against cards.name (see that migration's
-- comment on the literal " (Foil)" suffix). Unmatched items are still shown in the Orders
-- tab (via card_name_raw) but never drive a badge on a listing row, since a name-based
-- fallback risks pointing at the wrong card/listing.

CREATE OR REPLACE VIEW public.v_tcgplayer_orders AS
 SELECT
    o.id,
    o.order_number,
    o.order_total,
    o.ship_by,
    o.status,
    o.gmail_message_id,
    o.manage_order_url,
    o.ordered_at,
    o.shipped_at,
    o.created_at,
    COALESCE(array_agg(DISTINCT oi.card_id) FILTER (WHERE oi.card_id IS NOT NULL), '{}') AS matched_card_ids,
    string_agg(
        oi.card_name_raw ||
        CASE WHEN oi.foil THEN ' (Foil)' ELSE '' END ||
        CASE WHEN oi.quantity > 1 THEN (' ×' || oi.quantity) ELSE '' END,
        ', ' ORDER BY oi.card_name_raw
    ) AS all_item_names,
    COALESCE(sum(oi.quantity), 0) AS total_quantity,
    count(oi.id) FILTER (WHERE oi.card_id IS NULL) AS unmatched_item_count
   FROM tcgplayer_orders o
   LEFT JOIN tcgplayer_order_items oi ON (oi.order_id = o.id)
  GROUP BY o.id, o.order_number, o.order_total, o.ship_by, o.status, o.gmail_message_id, o.manage_order_url, o.ordered_at, o.shipped_at, o.created_at
  ORDER BY o.ordered_at DESC NULLS LAST, o.created_at DESC;

GRANT ALL ON TABLE public.v_tcgplayer_orders TO anon;
GRANT ALL ON TABLE public.v_tcgplayer_orders TO authenticated;
GRANT ALL ON TABLE public.v_tcgplayer_orders TO service_role;

-- Append a card_ids array to the active/sold listing views so the page can match a
-- listing row against v_tcgplayer_orders.matched_card_ids. tl.card_id is only set for
-- single-card listings (see Tcgplayerlistings.jsx's isSingleCard); lot listings carry
-- their cards in tcgplayer_listing_cards instead, so the array falls back to those.

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
    (tl.quantity * COALESCE(sum(tlc.quantity), 1)) AS total_quantity,
    CASE
        WHEN tl.card_id IS NOT NULL THEN ARRAY[tl.card_id]
        ELSE COALESCE(array_agg(DISTINCT tlc.card_id) FILTER (WHERE tlc.card_id IS NOT NULL), '{}')
    END AS card_ids
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
    (tl.quantity * COALESCE(sum(tlc.quantity), 1)) AS total_quantity,
    CASE
        WHEN tl.card_id IS NOT NULL THEN ARRAY[tl.card_id]
        ELSE COALESCE(array_agg(DISTINCT tlc.card_id) FILTER (WHERE tlc.card_id IS NOT NULL), '{}')
    END AS card_ids
   FROM (((tcgplayer_listings tl
     LEFT JOIN cards c ON ((c.id = tl.card_id)))
     LEFT JOIN tcgplayer_listing_cards tlc ON ((tlc.listing_id = tl.id)))
     LEFT JOIN cards lc_cards ON ((lc_cards.id = tlc.card_id)))
  WHERE (tl.status = 'sold'::text)
  GROUP BY tl.id, tl.title, tl.listed_price, tl.shipping_cost, tl.quantity, tl.sold_price, tl.sold_shipping, tl.sold_fee, tl.cost_basis, tl.net_profit, tl.sold_at, tl.listed_at, tl.condition, tl.notes, tl.tcgplayer_url, tl.card_id, c.name, c.set_name, c.rarity, c.foil, c.game_id
  ORDER BY tl.sold_at DESC;

GRANT ALL ON TABLE public.v_tcgplayer_active TO anon;
GRANT ALL ON TABLE public.v_tcgplayer_active TO authenticated;
GRANT ALL ON TABLE public.v_tcgplayer_active TO service_role;
GRANT ALL ON TABLE public.v_tcgplayer_sold TO anon;
GRANT ALL ON TABLE public.v_tcgplayer_sold TO authenticated;
GRANT ALL ON TABLE public.v_tcgplayer_sold TO service_role;
