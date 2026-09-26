-- trg_sync_quantity_owned previously *recomputed* cards.quantity_owned as
-- SUM(pack_cards.quantity) on every pack_cards write. That value is "copies
-- ever pulled", not "copies owned": sales (Ebaylistings/Tcgplayerlistings Sold
-- modals, the 20260911 order backfill) and manual Inventory edits decrement
-- quantity_owned directly, and the next pull of that same card overwrote them
-- with the lifetime pull count -- so logging a new box silently restored every
-- previously-sold copy of each card it touched (and dropped any copies owned
-- from outside pack tracking, e.g. Import.jsx rows or manual adds).
--
-- Make the trigger apply only the *change* in this row's counted quantity, so
-- quantity_owned stays a running balance that pulls, sales and manual edits
-- all adjust. Callers must therefore no longer also adjust quantity_owned
-- themselves around a pack_cards write (Boxes.jsx/Inventory.jsx/Import.jsx
-- updated alongside this migration).
CREATE OR REPLACE FUNCTION public.sync_quantity_owned() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  old_qty integer := 0;
  new_qty integer := 0;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.counts_inventory then
    old_qty := old.quantity;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.counts_inventory then
    new_qty := new.quantity;
  end if;

  if tg_op = 'UPDATE' and new.card_id is distinct from old.card_id then
    update cards set quantity_owned = greatest(0, quantity_owned - old_qty) where id = old.card_id;
    update cards set quantity_owned = greatest(0, quantity_owned + new_qty) where id = new.card_id;
  elsif new_qty <> old_qty then
    update cards
    set quantity_owned = greatest(0, quantity_owned + new_qty - old_qty)
    where id = coalesce(new.card_id, old.card_id);
  end if;

  return coalesce(new, old);
end;
$$;
