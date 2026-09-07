-- cards.quantity_owned is maintained by the trg_sync_quantity_owned trigger
-- (sync_quantity_owned()), which recomputes it as SUM(pack_cards.quantity) for
-- the card on every insert/update/delete to pack_cards. Boxes.jsx's "Don't
-- update inventory" checkbox (added in 0b5a68a) only skips its own manual
-- cards.quantity_owned update -- it still inserts the pull into pack_cards
-- unconditionally, so the trigger adds the quantity right back in, silently
-- doubling cards that were logged as "already sold before filming."
--
-- Give pack_cards a flag the trigger can filter on so a pull can be logged
-- for video/box tracking without being summed into quantity_owned.
ALTER TABLE public.pack_cards
  ADD COLUMN counts_inventory boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.sync_quantity_owned() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare target_card_id uuid;
begin
  target_card_id := coalesce(new.card_id, old.card_id);
  update cards
  set quantity_owned = (
    select coalesce(sum(quantity), 0)
    from pack_cards
    where card_id = target_card_id and counts_inventory
  )
  where id = target_card_id;
  return new;
end;
$$;
