# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Vite dev server (default http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run preview` — serve the built bundle locally
- No test, lint, or typecheck scripts are configured.

Env vars (required for full functionality — `src/lib/supabase.js` throws at startup if the Supabase vars are missing):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ANTHROPIC_KEY` — required by Listing Suggestions (AI lot analysis) and Rules Chat
- `VITE_OPENAI_KEY` — required by Rules Chat (embedding lookups via OpenAI)

## Architecture

Pure client-side SPA: Vite + React 18 + react-router-dom v6, talking directly to a Supabase project. There is no backend in this repo — all persistence, auth, realtime, and the scheduled price check live in Supabase (Postgres tables, views, and an Edge Function).

### Entry and routing

`src/main.jsx` mounts `<BrowserRouter>` → `App`. `src/App.jsx` is the canonical app shell: it checks the Supabase session, renders `<Login />` when unauthenticated, and otherwise renders `<Sidebar>` plus a `<Routes>` block. Each top-level route maps 1:1 to a file in `src/pages/`:

| Route | File | Purpose |
|---|---|---|
| `/` | `Dashboard.jsx` | Portfolio overview, metrics |
| `/inventory` | `Inventory.jsx` | Card list with inline edit |
| `/alerts` | `Alerts.jsx` | Price alert review + dismiss |
| `/listings` | `Ebaylistings.jsx` | eBay listing CRUD (2-step modal) |
| `/tcgplayer-listings` | `Tcgplayerlistings.jsx` | TCGPlayer listing CRUD (2-step modal, 13.25% + $0.30 fee) |
| `/sales` | `Sales.jsx` | Combined eBay + TCGPlayer sold-cards feed, weekly/monthly breakdown |
| `/suggestions` | `Listingsuggestions.jsx` | AI-powered lot grouping + eBay creation |
| `/boxes` | `Boxes.jsx` | Sealed product P&L |
| `/market` | `Market.jsx` | Manual price-check trigger |
| `/youtube` | `YouTube.jsx` | Pack opening tracker + shareable summary cards |
| `/import` | `Import.jsx` | Google Sheets bulk import |
| `/settings` | `Settings.jsx` | `check_schedule` settings row |
| `/rules` | `RulesChat.jsx` | RAG-based rulebook Q&A chatbot |
| `/boxev` | `BoxEV.jsx` | Box/pack expected-value analytics (read-only) |

### Supabase as the data layer

`src/lib/supabase.js` exports a single shared `supabase` client. Pages call it directly with `supabase.from(...)` — there is no repository/service abstraction. When changing data flow, grep page files for the relevant table/view name.

Tables referenced by the UI:
- `games` — the games tracked by the app (Sorcery, Riftbound, ...): `name, slug, is_active, sort_order`. Root FK target for `cards.game_id` / `boxes.game_id`. See "Multi-game support" below.
- `cards` — primary inventory: `name, set_name, set_code, rarity, condition, foil, card_type, cost_basis, quantity_owned, quantity_listed, image_url, tcgplayer_id, notes, game_id` (`quantity_available` and `active_listing_count` are view-only — read from `v_inventory_dashboard`, not this table). `card_type` and `cost_basis` are real columns despite not appearing in older schema dumps.
- `price_snapshots` — historical prices: `card_id, tcgplayer_low, tcgplayer_mid, tcgplayer_market, ebay_sold_avg, ebay_sold_low, ebay_sold_high`
- `price_alerts` — generated alerts: `card_id, alert_type, message, old_price, new_price, pct_change, dismissed`
- `ebay_listings` — outbound listings: `card_id, title, listed_price, shipping_cost, condition, ebay_fee, net_listed, status, ebay_url, notes, cost_basis`; sold fields: `sold_price, sold_shipping, sold_ebay_fee, net_profit, sold_at`
- `ebay_listing_cards` — junction for multi-card listings: `listing_id, card_id, price, quantity`
- `tcgplayer_listings` — TCGPlayer channel listings, same shape/lifecycle as `ebay_listings`: `card_id, title, listed_price, shipping_cost, condition, quantity, tcg_fee, net_listed, status, tcgplayer_url, notes, cost_basis`; sold fields: `sold_price, sold_shipping, sold_fee, net_profit, sold_at`. `tcg_fee`/`net_listed` are generated columns using a flat 13.25% + $0.30 commission (10.75% marketplace + 2.5% + $0.30 payment processing, TCGPlayer's standard-seller rate as of 2026-09) computed on `listed_price` only, minus `shipping_cost` for `net_listed` (see `supabase/migrations/20260905_tcgplayer_fee_update.sql`, which superseded the original flat-10.25%-no-processing-fee model). `shipping_cost` defaults to `$5.00`
- `tcgplayer_listing_cards` — junction for multi-card TCGPlayer listings: `listing_id, card_id, price, quantity`
- `boxes` — sealed product purchases: `name, set_name, set_code, box_type, purchase_price, pack_count, pack_msrp, purchased_at, opened_at, seller, notes, box_ref, game_id` (`box_ref` is a unique slug used for import linking)
- `packs` — individual packs within a box: `box_id, pack_number, opened_at, notes, pack_ref` (`pack_ref` is a unique slug used for import linking)
- `pack_cards` — cards recorded within each pack: `pack_id, card_id, quantity, counts_inventory`. **`cards.quantity_owned` is not a plain column the app manages** — a `trg_sync_quantity_owned` trigger recomputes it after every insert/update/delete on `pack_cards` as `SUM(quantity) WHERE card_id = ... AND counts_inventory`, once any `pack_cards` row exists for that card. `Boxes.jsx`'s pull-logging flow (`savePull`) therefore only ever writes `pack_cards`, never `cards.quantity_owned` directly — its "Don't update inventory" checkbox works by setting `counts_inventory: false` on the row rather than skipping a manual update, since the pre-2026-09-04 version of that checkbox skipped only the JS-side update while the trigger added the pull's quantity back in anyway (see `supabase/migrations/20260904_pack_cards_counts_inventory.sql`). A card already logged in a pack is merged additively (existing quantity + new) when re-added via the "Add card" search rather than upserted-and-overwritten, for the same reason. Cards manually created/edited outside of pack pulls (Import.jsx, Inventory.jsx) are unaffected by the trigger until/unless a `pack_cards` row for them is created.
- `youtube_openings` — video opening records: `id, title, box_id, youtube_url, filmed_at`
- `youtube_opening_packs` — junction: which packs appear in a given opening: `opening_id, pack_id`
- `check_schedule` — single-row settings table: `frequency, run_at_hour, alert_pct_up, alert_pct_down, stale_days, email_alerts, email_address`
- `document_chunks` — rulebook embeddings for RAG: `source, source_id, content, embedding (vector), metadata (jsonb)` — queried via the `match_documents` RPC, not directly

Enums used in inserts (must match the DB):
- rarity: **not an enum** — `cards.rarity` is `text`, validated only at the app layer via `GAME_CONFIG[game.slug].rarities` in `src/lib/games.js` (Sorcery: `ordinary | exceptional | elite | unique`; Riftbound: `common | uncommon | rare | epic | overnumbered`). This changed from a Postgres enum in the 2026-08-10 multi-game migration since rarity vocabulary differs per game.
- condition: `near_mint | lightly_played | moderately_played | heavily_played | damaged` (still a real Postgres enum — shared across all games, grading terminology is a universal TCG standard)
- box_type: `booster_box | single_booster | prerelease_kit | bundle | other`
- listing status: `active | sold | ended | cancelled`

Views the UI reads from (heavier joins/aggregations live in Postgres, not the client):
- `v_inventory_dashboard` — cards joined with latest prices, `market_value`, `unrealized_pnl`, `quantity_listed`, `quantity_available`, `active_listing_count`
- `v_latest_prices` — most recent price snapshot per card
- `v_active_alerts` — undismissed alerts joined with card info
- `v_box_pnl` — boxes with `cards_market_value`, `gross_pnl`
- `v_youtube_opening_summary` — openings joined with pack/card aggregates: `total_tcg_value`, `opening_pnl`, `packs_cost`, `packs_in_video`, `pack_msrp`, `pack_count`, `box_name`, `set_name`
- `v_price_gainers_losers` — 7-day price movers per card: `card_id, name, rarity, foil, current_price, price_7d_ago, pct_change`
- `v_tcgplayer_active` / `v_tcgplayer_sold` — active/sold TCGPlayer listings joined with card + lot info (mirrors `v_ebay_active`/`v_ebay_sold`)
- `v_ebay_active`/`v_ebay_sold`/`v_tcgplayer_active`/`v_tcgplayer_sold` all expose `total_quantity` — the actual physical card count a listing represents (`quantity` bundle-multiplier × the sum of each card's junction-row `quantity`). Use this for "how many cards" math; the raw `quantity` column is just the bundle multiplier (always selected as-is on the TCGPlayer views, never selected at all on the eBay ones before this), and `card_count` is a `COUNT(DISTINCT card_id)` meant only for "does this lot have more than one distinct card" — both undercount whenever a card's own lot quantity is > 1. `all_card_names` appends ` ×N` per card when its lot quantity is > 1 (active and sold views alike). Added 2026-08-15 after `Sales.jsx` surfaced "cards sold" totals that didn't match the underlying listings; see `supabase/migrations/20260815_fix_listing_total_quantity.sql` and `20260815_add_quantity_suffix_to_sold_lot_names.sql`.
- `v_tcgplayer_pnl` — aggregate TCGPlayer revenue/fees/profit (mirrors `v_global_pnl`)
- `v_ebay_pnl_by_game` / `v_tcgplayer_pnl_by_game` — per-game equivalents of `v_global_pnl`/`v_tcgplayer_pnl` (one row per `game_id`, same columns), queried with `.eq('game_id', activeGame.id).maybeSingle()` by `Ebaylistings.jsx`/`Tcgplayerlistings.jsx` for their metric cards and Business P&L tab. `v_global_pnl`/`v_tcgplayer_pnl` themselves are unchanged and stay whole-account (see below and `v_combined_pnl`). A listing with no linkable card (see the `total_quantity` note below) has no game to attribute revenue to, so it's excluded from these by-game totals even though it's still visible in the Active/Sold tables.
- `v_combined_pnl` — `v_global_pnl` (eBay) + `v_tcgplayer_pnl` (TCGPlayer) summed into one row. Used only by `Dashboard.jsx` for the "Business net profit" panel, since that figure nets revenue against *all* box spend — computing it per-channel double-counted box costs (a card sold on one channel still looked like unsold stock in the other channel's math). The `Ebaylistings.jsx`/`Tcgplayerlistings.jsx` Business P&L tabs show channel-scoped revenue/fees/COGS only and link to the Dashboard for the combined number

When adding a feature that needs joined data, prefer creating/extending a view over composing joins in JS.

Most app-facing views above also expose a `game_id` column (added in the 2026-08-10 multi-game migration) so pages can `.eq('game_id', activeGame.id)`. Exceptions that stay all-games-combined on purpose: `v_global_pnl`, `v_tcgplayer_pnl`, `v_combined_pnl`. For `v_ebay_active`/`v_ebay_sold`/`v_tcgplayer_active`/`v_tcgplayer_sold`, `game_id` is `COALESCE(c.game_id, max(<junction cards>.game_id))` rather than a plain column, because multi-card lot listings have no single `card_id` to read it from directly — and it's `NULL` for a listing with neither a `card_id` nor lot rows (never linked to a card yet). `Ebaylistings.jsx`/`Tcgplayerlistings.jsx`/`Sales.jsx` all query these four views with `.or('game_id.eq.<activeGame.id>,game_id.is.null')`, not a plain `.eq()` — a plain `.eq()` silently drops every `NULL`-`game_id` row (SQL `NULL = x` is never true), which is what hid the "Show Unlinked Cards" workflow and undercounted sold totals until the 2026-08-15 fix. Use the same `.or()` pattern in any new query against these views.

### Multi-game support

The app tracks multiple TCGs (Sorcery, Riftbound, more later) in one shared schema. `cards` and `boxes` — the two root entities everything else joins through — carry a `game_id` FK into the `games` table; every other table (`price_snapshots`, `ebay_listings`, `tcgplayer_listings`, `packs`, `pack_cards`, `youtube_openings`, junctions) is scoped transitively via `card_id`/`box_id`, not its own `game_id` column.

- **`src/context/GameContext.jsx`** — `GameProvider` (wraps the private app shell in `App.jsx`, inside `PrivateLayout`) fetches `games` once, tracks `activeGame` (persisted to `localStorage`), and exposes `useGame()` → `{ games, activeGame, setActiveGame, alertCount, decrementAlertCount }`. `alertCount` is the sidebar's Price Alerts badge count, scoped to `activeGame.id` and refetched whenever the active game changes or `price_alerts` changes via realtime (see "Realtime" below); `Dashboard.jsx`/`Alerts.jsx` call `decrementAlertCount(n = 1)` after dismissing so the badge updates instantly instead of waiting on the realtime round-trip. Public routes (`Home.jsx`, `PublicCards.jsx`, `CardDetail.jsx`, `RulesChat.jsx`) render outside this provider and are **not** game-scoped — they only ever show Sorcery data today.
- **`src/lib/games.js`** — `GAME_CONFIG[slug]` is the single source of per-game vocabulary: `rarities`, `cardTypes`, `sets`, `defaultSet`/`defaultRarity`, `tcgplayerSlug` (for building TCGPlayer search links), `fillerCardValue` (BoxEV's flat per-pack filler-card estimate), `rarityMap` (Import.jsx normalization), and `grouping` (Listing Suggestions tier config: `eligibleRarities`, `soloRarities`, `secondaryRarity`, `pooledSpecialType`/`pooledSpecialLabel`). Adding a new game = one row in `games` (via SQL) + one entry here.
- **`Sidebar.jsx`** renders a game switcher (`<select>`) when more than one game is active.
- Every scoped page follows the same pattern: table/view queries gain `.eq('game_id', activeGame.id)`, insert payloads gain `game_id: activeGame.id`, and hard-coded rarity/set/card-type dropdown arrays are replaced by `gameConfig(activeGame.slug)` lookups.
- `check_schedule` (price-check cadence/alert thresholds) and `v_combined_pnl`/`v_global_pnl`/`v_tcgplayer_pnl` (channel P&L) are deliberately **not** game-scoped — they stay whole-account totals. The sidebar's alert-count badge, by contrast, **is** game-scoped (see `GameContext.jsx` above) — it only counts the active game's undismissed alerts.
- `daily_price_check` needs no game awareness — it prices every card by `tcgplayer_id` regardless of game.
- Migration: `supabase/migrations/20260810_multi_game_support.sql`.

### Realtime

`src/context/GameContext.jsx`'s `GameProvider` subscribes to `postgres_changes` on `price_alerts` to keep the sidebar badge (`alertCount`) live — this requires `price_alerts` to be added to the `supabase_realtime` publication (`supabase/migrations/20260826_realtime_price_alerts.sql`; it was missing from the initial schema, which silently broke live updates). Other pages re-fetch on mount; only the alert badge uses realtime.

### Pricing pipeline

Two independent pieces feed `price_snapshots`, neither aware of the other:

- **TCGPlayer prices** — populated by an external **Google Apps Script** (runs on its own daily trigger inside Google's infrastructure, not Supabase). A reference copy lives at `apps-script/tcg-price-pipeline.gs` (paste into the Apps Script editor to deploy; it is not executed from this repo). It pulls Sorcery + Riftbound catalog/price data from `tcgcsv.com`, stages it in a "Prices" Google Sheet, then upserts into `price_snapshots.tcgplayer_low/mid/market` by matching `cards.tcgplayer_id`. It also has a manually-run `seedCardsFromTcgPlayer()` to insert new cards (setting `game_id` via a `games` table lookup — the script resolves `game_id` at runtime since `cards` has no plain `game` text column). Auth is a Supabase **service role key** stored in the script's Properties Service, so it bypasses RLS entirely.
- **eBay prices** — populated by the Supabase Edge Function at `supabase/functions/daily_price_check/index.ts`, invoked via the Market page (`${VITE_SUPABASE_URL}/functions/v1/daily_price_check`, POST, bearer = anon key) or its own schedule. Despite the name, it does **not** call TCGPlayer — it only backfills `ebay_sold_avg/low/high/count` on rows that already have `tcgplayer_market` set (i.e. it runs after the Apps Script). The schedule is configured via the `check_schedule` row in the Settings page.

Both are already game-agnostic at the `price_snapshots` level (matched by `card_id`, not `game_id` — that table has no game column of its own). `daily_price_check/index.ts` does still hardcode "Sorcery TCG" in its eBay search query strings and email branding — those would need updating for Riftbound eBay price coverage.

### Listing Suggestions + AI (Listingsuggestions.jsx)

Groups unlisted high-rarity cards into eBay lots using a client-side algorithm (`groupCards(cards, config)`), driven by the active game's `GAME_CONFIG[...].grouping` (see "Multi-game support"): `soloRarities` get their own foil/non-foil lots, `secondaryRarity` gets one more non-foil tier, `pooledSpecialType` (e.g. Sorcery's "site" cards) always pools regardless of rarity, and everything packs into lots of ≤ 6 cards targeting ≥ $20 total. After grouping, the "AI analyse lots" button calls the **Anthropic Messages API directly from the browser** (`https://api.anthropic.com/v1/messages`) using `VITE_ANTHROPIC_KEY`. Creating a listing writes to `ebay_listings` and `ebay_listing_cards`, then increments `quantity_listed` on each card.

Fee constants in this file (`EBAY_FEE_PCT = 0.129`, `EBAY_FEE_FLAT = 0.30`, `DEFAULT_SHIP = 5.00`) are shared with `Ebaylistings.jsx` — if you change fee rates, update both files. In `App.jsx` the eBay page is imported as `EbayListings` (not the generic `Listings`) to stay unambiguous now that `TcgplayerListings` also exists.

### TCGPlayer Listings (Tcgplayerlistings.jsx)

A second listing channel, structurally identical to `Ebaylistings.jsx` (2-step create modal, edit/sold/end/link/delete-sold modals, `shipping_cost`/`sold_shipping` fields) but backed by its own tables (`tcgplayer_listings`, `tcgplayer_listing_cards`) and views (`v_tcgplayer_active`, `v_tcgplayer_sold`, `v_tcgplayer_pnl`) rather than the eBay ones. Differences from the eBay page: shipping defaults to `$5.00` (`TCG_SHIP_DEFAULT`) rather than eBay's `$0`/`$4` defaults, a flat `TCG_FEE_PCT = 0.1025` commission instead of eBay's fee formula, and a `tcgplayer_url` field instead of `ebay_url`. Marking a listing sold decrements the same `cards.quantity_owned`/`quantity_listed` columns eBay sales do, so inventory reflects both channels together — `quantity_listed` is not channel-specific.

### Sales (Sales.jsx)

Combines `v_ebay_sold` and `v_tcgplayer_sold` (game-scoped) into one feed: summary metrics (cards sold, revenue, net profit, avg sale price), a Weekly/Monthly breakdown chart (Cards Sold/Revenue/Net Profit toggle, `recharts`) grouped client-side by `sold_at`, and a merged sold-cards table with a channel filter. `net_profit` is read straight from the views — it's already cost-basis-net (computed as `net proceeds - cost_basis` in Ebaylistings.jsx/Tcgplayerlistings.jsx's Sold modals and frozen onto the row at sale time), so this page doesn't re-subtract cost basis itself. "Cards sold" and the chart's Cards Sold/Revenue series use `total_quantity`, not `quantity` or `card_count` (see the views note above). Channel bar colors (`EBAY_COLOR`/`TCG_COLOR` constants in this file) are a dark-surface-validated pair, not the raw `--gold`/eBay-badge-blue values used elsewhere in the UI.

### YouTube page (YouTube.jsx)

Tracks pack-by-pack openings filmed for YouTube. An opening links a set of `packs` from a `box` via `youtube_opening_packs`. The detail view fetches `pack_cards` for each pack (one query per pack) then joins against `v_latest_prices` to price each card. The `SummaryCard` component renders a shareable screenshot-ready summary (screenshotted via the browser, not a canvas API). Expects the `packs` table to be pre-populated per box.

### Bulk import (Import.jsx)

Imports cards + boxes from a published Google Sheet (`/pub` or `/spreadsheets/d/...` URLs are both parsed). Expects exact tab names `Cards` and `Boxes`. CSV is fetched client-side and parsed with a small hand-rolled parser that handles quoted commas. Rarity free-text values are normalized through the active import game's `GAME_CONFIG[...].rarityMap` (a "Importing into" game selector, defaulting to the sidebar's active game, sits above the tab bar); condition is fixed to `near_mint` on import. Cards are matched for upsert on `(name, set_name, condition, game_id)`. Cards reference their originating box via a `box_ref` column in the sheet which is resolved to the inserted box's UUID at import time (sheet-only concept, not a DB column).

### WeeklyMovers component

`src/components/Weeklymovers.jsx` reads `v_price_gainers_losers` and renders top-5 gainers/losers side by side. It is imported and rendered in `Dashboard.jsx`.

### Rules Chat (RulesChat.jsx)

RAG-based chatbot for answering Sorcery TCG rules questions. On each query it:
1. Calls OpenAI `text-embedding-3-small` (`VITE_OPENAI_KEY`) to embed the user question
2. Calls Supabase RPC `match_documents` (pgvector similarity search) to retrieve relevant rulebook chunks where `source = 'rulebook'`
3. Passes retrieved chunks as context to Anthropic `claude-haiku-4-5-20251001` (`VITE_ANTHROPIC_KEY`) to generate the answer

The `match_documents` RPC and the rulebook document embeddings must be set up in the Supabase project before this page works. The conversation history is kept in component state only (not persisted to the DB).

### Styling

Single global stylesheet at `src/index.css` defines a CSS-variable design system (gold-on-dark, Cinzel + DM Sans). No CSS-in-JS library, no Tailwind, no per-component CSS. Reuse existing utility classes: `.panel`, `.panel-header`, `.data-table`, `.metric-card`, `.badge badge-<rarity|ok|alert>`, `.btn btn-primary|ghost|danger`, `.form-input`, `.form-select`, `.empty-state`, `.loading`, `.text-success|text-danger|text-gold|text-muted`. Inline `style={{}}` is used freely for one-offs — match that convention rather than adding new class files.
