-- One-time bulk fix: every tcgplayer_listings row auto-created by create_tcgplayer_order
-- (satorntcg-mcp-server) was inserted with status='active', but every order that tool
-- processes represents a card that had *already sold* on TCGplayer -- there's no "for sale"
-- window for these, so they should have been 'sold' from the start. This flips the
-- still-active ones to 'sold' using the same math the tool now uses at creation time
-- (sold_price/sold_shipping/sold_fee/cost_basis/net_profit), and corrects the inventory
-- counters the bug left wrong: quantity_listed was bumped at creation and never reversed,
-- and quantity_owned was never decremented at all.
--
-- Selection is by the notes text the tool stamps on every row it creates
-- ('Auto-created from TCGplayer order %'), so manually-created listings are untouched.
-- Safe to re-run: once a row is 'sold' it no longer matches status = 'active' here, so a
-- second run is a no-op.

BEGIN;

CREATE TEMP TABLE _tcg_order_listing_fix AS
SELECT tl.id, tl.listed_price, tl.shipping_cost, tl.tcg_fee, tl.net_listed, tl.listed_at
FROM public.tcgplayer_listings tl
WHERE tl.status = 'active'
  AND tl.notes LIKE 'Auto-created from TCGplayer order %';

WITH cost AS (
  SELECT f.id AS listing_id,
         SUM(COALESCE(c.cost_basis, 0) * tlc.quantity) AS cost_basis_total
  FROM _tcg_order_listing_fix f
  LEFT JOIN public.tcgplayer_listing_cards tlc ON tlc.listing_id = f.id
  LEFT JOIN public.cards c ON c.id = tlc.card_id
  GROUP BY f.id
)
UPDATE public.tcgplayer_listings tl
SET status        = 'sold',
    sold_price    = tl.listed_price,
    sold_shipping = tl.shipping_cost,
    sold_fee      = tl.tcg_fee,
    cost_basis    = NULLIF(cost.cost_basis_total, 0),
    net_profit    = round(tl.net_listed - COALESCE(cost.cost_basis_total, 0), 2),
    sold_at       = tl.listed_at
FROM cost
WHERE tl.id = cost.listing_id;

WITH card_deltas AS (
  SELECT tlc.card_id, SUM(tlc.quantity) AS qty
  FROM _tcg_order_listing_fix f
  JOIN public.tcgplayer_listing_cards tlc ON tlc.listing_id = f.id
  GROUP BY tlc.card_id
)
UPDATE public.cards c
SET quantity_owned  = GREATEST(0, c.quantity_owned  - cd.qty),
    quantity_listed = GREATEST(0, c.quantity_listed - cd.qty)
FROM card_deltas cd
WHERE c.id = cd.card_id;

DROP TABLE _tcg_order_listing_fix;

COMMIT;
