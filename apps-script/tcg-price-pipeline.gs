// ============================================================
// SatornTCG — Multi-Game TCGPlayer Price Pipeline
//
// Supports:
//   • Sorcery: Contested Realm
//   • Riftbound: League of Legends TCG
//
// Pipeline:
//   TCGCSV → Google Sheet → Supabase
//
// Runs daily via Apps Script trigger
//
// NOTE (2026-08-10): cards.game_id is a uuid FK into the `games`
// table (see supabase/migrations/20260810_multi_game_support.sql),
// NOT a plain `game` text column. Every place that touches Supabase
// `cards` below resolves gameName ("Sorcery"/"Riftbound") to its
// games.id via getGameIdMap_() rather than writing/filtering on a
// `game` text field, which does not exist on the table.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const SUPABASE_URL = "https://fctyxspeishvjhlyfpbs.supabase.co";

const SUPABASE_KEY =
  PropertiesService
    .getScriptProperties()
    .getProperty("SUPABASE_SERVICE_ROLE_KEY");

const TCGCSV_BASE = "https://tcgcsv.com/tcgplayer";


// ============================================================
// GAME CONFIGURATION
// ============================================================

const TCG_GAMES = {

  Sorcery: {
    category: "Sorcery",

    sets: [
      "Gothic",
      "Arthurian Legends",
      "Beta",
      "Alpha"
    ]
  },

  Riftbound: {
    category: "Riftbound",

    sets: [
      "Origins",
      "Spiritforged",
      "Unleashed",
      "Vendetta"
    ]
  }

};


// ============================================================
// PRODUCTS TO SKIP
// ============================================================

const SKIP_KEYWORDS = [

  // Generic sealed products
  "booster box",
  "booster pack",
  "booster case",
  "booster display",
  "display case",
  "bundle",
  "sealed",

  // Sorcery
  "preconstructed deck",
  "precon deck",
  "the four elementals preconstructed",
  "prophets of doom preconstructed",
  "team covenant",
  "store alternate art",
  "scgcon promo",
  "pledge pack",

  // Riftbound
  "starter deck",
  "champion deck",
  "proving grounds",

  // Accessories
  "playmat",
  "deck box",
  "sleeves"
];


// ============================================================
// ENTRY POINT
//
// Keep your existing Apps Script trigger pointed at:
//
// dailyPriceUpdate
//
// ============================================================

function dailyPriceUpdate() {

  Logger.log("========================================");
  Logger.log("STARTING DAILY TCG PRICE UPDATE");
  Logger.log("========================================");

  pullAllTCGCards();

  pushPricesToSupabase();

  Logger.log("========================================");
  Logger.log("DAILY TCG PRICE UPDATE COMPLETE");
  Logger.log("========================================");

}


// ============================================================
// STEP 1
//
// Pull Sorcery + Riftbound cards from TCGCSV.
//
// Writes to Prices sheet.
//
// Columns:
//
// A Card Name
// B TCGplayer Product ID
// C Market Price
// D Rarity
// E Set
// F Low Price
// G High Price
// H Game
// I Foil
//
// (This step never touches Supabase, so it needs no game_id
// awareness — the "Game" column here is just the TCG_GAMES key,
// consumed by pushPricesToSupabase() below purely for logging.)
//
// Some games (Riftbound, like Pokémon) sell Normal + Foil printings
// of the SAME card under one shared TCGplayer productId, distinguished
// only by pricing subTypeName — not as separate catalog products the
// way Sorcery's foil cards are (their own productId, "(Foil)" in the
// name). So one product can produce ONE OR TWO rows here.
//
// ============================================================

function pullAllTCGCards() {

  const spreadsheet =
    SpreadsheetApp.getActiveSpreadsheet();

  const sheet =
    spreadsheet.getSheetByName("Prices");

  if (!sheet) {
    throw new Error(
      'Sheet named "Prices" was not found.'
    );
  }

  // Clear once.
  // Important: individual games do NOT clear the sheet.
  sheet.clearContents();

  sheet
    .getRange(1, 1, 1, 9)
    .setValues([[
      "Card Name",
      "TCGplayer Product ID",
      "Market Price",
      "Rarity",
      "Set",
      "Low Price",
      "High Price",
      "Game",
      "Foil"
    ]]);


  const allRows = [];

  let totalGroups = 0;


  // ========================================================
  // LOOP THROUGH EACH GAME
  // ========================================================

  Object.entries(TCG_GAMES)
    .forEach(([gameName, config]) => {

      Logger.log("");
      Logger.log(
        `========== ${gameName.toUpperCase()} ==========`
      );

      const categoryId =
        findCategoryId_(config.category);

      if (!categoryId) {

        Logger.log(
          `ERROR: ${gameName} category not found`
        );

        return;
      }


      Logger.log(
        `${gameName} category ID: ${categoryId}`
      );


      // ----------------------------------------------------
      // Find requested sets
      // ----------------------------------------------------

      const groupsData =
        fetchJson_(
          `${TCGCSV_BASE}/${categoryId}/groups`
        );


      const targetGroups =
        (groupsData.results || [])
          .filter(group => {

            const groupName =
              (group.name || "")
                .toLowerCase();

            return config.sets.some(set =>
              groupName.includes(
                set.toLowerCase()
              )
            );

          });


      Logger.log(
        `Found ${targetGroups.length} ${gameName} groups: ` +
        targetGroups
          .map(g => g.name)
          .join(", ")
      );


      totalGroups += targetGroups.length;


      // ====================================================
      // LOOP THROUGH SETS
      // ====================================================

      targetGroups.forEach(group => {

        const {
          groupId,
          name: setName
        } = group;


        Logger.log("");
        Logger.log(
          `── ${gameName}: ${setName} ──`
        );


        // --------------------------------------------------
        // Products
        // --------------------------------------------------

        const products =
          (
            fetchJson_(
              `${TCGCSV_BASE}/${categoryId}/${groupId}/products`
            )
          ).results || [];


        // --------------------------------------------------
        // Prices
        // --------------------------------------------------

        const prices =
          (
            fetchJson_(
              `${TCGCSV_BASE}/${categoryId}/${groupId}/prices`
            )
          ).results || [];


        // --------------------------------------------------
        // Build price lookup
        //
        // productId → array of printings (one per subTypeName —
        // "Normal", "Foil", ...). Most products only ever have one.
        //
        // --------------------------------------------------

        const priceMap = new Map();


        prices.forEach(price => {

          if (!price.productId) {
            return;
          }


          if (!priceMap.has(price.productId)) {
            priceMap.set(price.productId, []);
          }


          priceMap.get(price.productId).push({

            subTypeName:
              price.subTypeName || "",

            marketPrice:
              price.marketPrice !== null &&
              price.marketPrice !== ""

                ? price.marketPrice

                : (price.midPrice ?? ""),


            lowPrice:
              price.lowPrice ?? "",


            highPrice:
              price.highPrice ?? ""

          });

        });


        let added = 0;
        let skipped = 0;


        // --------------------------------------------------
        // Products → Sheet rows (one row per printing)
        // --------------------------------------------------

        products.forEach(product => {

          const name =
            (product.name || "").trim();


          if (!name) {
            return;
          }


          if (isSkippable_(name)) {

            skipped++;

            return;
          }


          const tcgRarity =
            getRarity_(product);


          const rarity =
            normalizeRarity_(
              gameName,
              tcgRarity
            );


          // No pricing data yet for this product → still emit one row
          // (blank price), foil decided from the name alone.
          const printings =
            priceMap.get(product.productId) || [{
              subTypeName: "", marketPrice: "", lowPrice: "", highPrice: ""
            }];


          printings.forEach(printing => {

            const isFoil =
              isFoilPrinting_(
                printing.subTypeName,
                name
              );


            allRows.push([

              name,

              product.productId || "",

              printing.marketPrice ?? "",

              rarity,

              setName,

              printing.lowPrice ?? "",

              printing.highPrice ?? "",

              gameName,

              isFoil

            ]);

          });


          added++;

        });


        Logger.log(
          `${setName}: ${products.length} products | ` +
          `${added} cards added | ` +
          `${skipped} products skipped`
        );

      });

    });


  // ========================================================
  // WRITE EVERYTHING TO SHEET
  // ========================================================

  if (allRows.length > 0) {

    sheet
      .getRange(
        2,
        1,
        allRows.length,
        9
      )
      .setValues(allRows);

  }


  // Price formatting

  sheet
    .getRange("C:C")
    .setNumberFormat("$0.00");

  sheet
    .getRange("F:F")
    .setNumberFormat("$0.00");

  sheet
    .getRange("G:G")
    .setNumberFormat("$0.00");


  sheet.setFrozenRows(1);


  Logger.log("");
  Logger.log(
    `TOTAL: ${allRows.length} cards ` +
    `across ${totalGroups} groups`
  );

}


// ============================================================
// STEP 2
//
// Push Prices sheet → Supabase price_snapshots
//
// Supports both Sorcery + Riftbound automatically because
// everything is matched using TCGplayer product ID.
//
// price_snapshots has no game_id of its own — it's scoped
// transitively via card_id → cards.game_id, so this step needs
// no game awareness at all, just the tcgplayer_id → card_id map.
//
// ============================================================

function pushPricesToSupabase() {

  const sheet =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName("Prices");


  const lastRow =
    sheet.getLastRow();


  if (lastRow < 2) {

    Logger.log(
      "No price rows found."
    );

    return;
  }


  // ========================================================
  // Read 9 columns
  //
  // name
  // productId
  // marketPrice
  // rarity
  // set
  // lowPrice
  // highPrice
  // game
  // foil
  // ========================================================

  const data =
    sheet
      .getRange(
        2,
        1,
        lastRow - 1,
        9
      )
      .getValues();


  // ========================================================
  // Load all cards from Supabase
  //
  // Pagination required because Supabase caps page size.
  // ========================================================

  const productIdMap =
    new Map();


  let from = 0;

  const pageSize = 1000;


  while (true) {

    const pageResp =
      UrlFetchApp.fetch(

        `${SUPABASE_URL}/rest/v1/cards` +
        `?select=id,name,tcgplayer_id,foil` +
        `&tcgplayer_id=not.is.null` +
        `&limit=${pageSize}` +
        `&offset=${from}`,

        {

          headers: {

            "apikey":
              SUPABASE_KEY,

            "Authorization":
              `Bearer ${SUPABASE_KEY}`,

            "Content-Type":
              "application/json",

            "Range-Unit":
              "items",

            "Range":
              `${from}-${from + pageSize - 1}`

          },

          muteHttpExceptions: true

        }

      );


    const status =
      pageResp.getResponseCode();


    if (status < 200 || status >= 300) {

      throw new Error(
        `Unable to load Supabase cards: ` +
        pageResp.getContentText()
      );

    }


    const page =
      JSON.parse(
        pageResp.getContentText()
      );


    if (!page.length) {
      break;
    }


    page.forEach(card => {

      if (card.tcgplayer_id) {

        // Keyed by productId+foil, not just productId — Riftbound-style
        // games can have two cards (Normal/Foil) sharing one productId.
        productIdMap.set(
          printingKey_(
            card.tcgplayer_id,
            card.foil
          ),

          card.id
        );

      }

    });


    Logger.log(
      `Loaded cards ${from}–` +
      `${from + page.length - 1}`
    );


    if (page.length < pageSize) {
      break;
    }


    from += pageSize;

  }


  Logger.log(
    `Loaded ${productIdMap.size} cards ` +
    `with TCGplayer IDs from Supabase`
  );


  // ========================================================
  // Today's snapshots
  // ========================================================

  const todayStart =
    new Date();


  todayStart.setUTCHours(
    0,
    0,
    0,
    0
  );


  const snapsResp =
    UrlFetchApp.fetch(

      `${SUPABASE_URL}/rest/v1/price_snapshots` +
      `?select=id,card_id,tcgplayer_market` +
      `&checked_at=gte.${todayStart.toISOString()}`,

      {

        headers: {

          "apikey":
            SUPABASE_KEY,

          "Authorization":
            `Bearer ${SUPABASE_KEY}`,

          "Content-Type":
            "application/json"

        },

        muteHttpExceptions: true

      }

    );


  if (
    snapsResp.getResponseCode() < 200 ||
    snapsResp.getResponseCode() >= 300
  ) {

    throw new Error(
      "Unable to load today's snapshots: " +
      snapsResp.getContentText()
    );

  }


  const todaySnaps =
    JSON.parse(
      snapsResp.getContentText()
    );


  // card_id →
  // {
  //   snapId,
  //   hasPrice
  // }

  const snapMap =
    new Map();


  todaySnaps.forEach(snapshot => {

    snapMap.set(
      snapshot.card_id,
      {

        snapId:
          snapshot.id,

        hasPrice:
          snapshot.tcgplayer_market !== null &&
          snapshot.tcgplayer_market !== undefined

      }
    );

  });


  Logger.log(
    `${snapMap.size} cards already ` +
    `have snapshots today`
  );


  // ========================================================
  // Build inserts + updates
  // ========================================================

  const now =
    new Date().toISOString();


  const toInsert = [];

  const toUpdate = [];


  data.forEach(row => {

    const [
      name,
      productId,
      marketPrice,
      rarity,
      setName,
      lowPrice,
      highPrice,
      gameName,
      foil
    ] = row;


    if (
      !productId ||
      !marketPrice
    ) {
      return;
    }


    if (
      isSkippable_(name)
    ) {
      return;
    }


    const cardId =
      productIdMap.get(
        printingKey_(productId, foil)
      );


    if (!cardId) {

      Logger.log(
        `No Supabase card for TCGplayer ID ` +
        `${productId} (${gameName}: ${name})`
      );

      return;
    }


    const price =
      parseFloat(marketPrice) || null;


    const priceLow =
      parseFloat(lowPrice) || null;


    const priceHigh =
      parseFloat(highPrice) || null;


    if (!price) {
      return;
    }


    const existing =
      snapMap.get(cardId);


    // ------------------------------------------------------
    // No snapshot today → INSERT
    // ------------------------------------------------------

    if (!existing) {

      toInsert.push({

        card_id:
          cardId,

        tcgplayer_market:
          price,

        tcgplayer_low:
          priceLow,

        tcgplayer_mid:
          null,

        ebay_sold_avg:
          null,

        ebay_sold_low:
          null,

        ebay_sold_high:
          null,

        ebay_sold_count:
          null,

        checked_at:
          now,

        source_raw: {

          source:
            "tcgcsv_via_apps_script",

          game:
            String(gameName || ""),

          set:
            String(setName || ""),

          productId:
            String(productId),

          name:
            String(name),

          foil:
            Boolean(foil)

        }

      });

    }

    // ------------------------------------------------------
    // Snapshot exists but price null → UPDATE
    // ------------------------------------------------------

    else if (!existing.hasPrice) {

      toUpdate.push({

        snapId:
          existing.snapId,

        price:

          price,

        priceLow:
          priceLow,

        priceHigh:
          priceHigh,

        name:
          name,

        game:
          gameName

      });

    }

  });


  // ========================================================
  // INSERT NEW SNAPSHOTS
  //
  // batches of 50
  // ========================================================

  if (toInsert.length) {

    Logger.log(
      `Inserting ${toInsert.length} new snapshots...`
    );


    for (
      let i = 0;
      i < toInsert.length;
      i += 50
    ) {

      const batch =
        toInsert.slice(
          i,
          i + 50
        );


      const resp =
        UrlFetchApp.fetch(

          `${SUPABASE_URL}/rest/v1/price_snapshots`,

          {

            method:
              "post",

            headers: {

              "apikey":
                SUPABASE_KEY,

              "Authorization":
                `Bearer ${SUPABASE_KEY}`,

              "Content-Type":
                "application/json",

              "Prefer":
                "return=minimal"

            },

            payload:
              JSON.stringify(batch),

            muteHttpExceptions:
              true

          }

        );


      if (
        resp.getResponseCode() !== 201
      ) {

        Logger.log(
          `Insert batch failed: ` +
          resp.getContentText()
        );

      } else {

        Logger.log(
          `Inserted ${batch.length} snapshots OK`
        );

      }

    }

  } else {

    Logger.log(
      "No new snapshots to insert"
    );

  }


  // ========================================================
  // UPDATE NULL-PRICE SNAPSHOTS
  // ========================================================

  if (toUpdate.length) {

    Logger.log(
      `Updating ${toUpdate.length} snapshots ` +
      `with null tcgplayer_market...`
    );


    toUpdate.forEach(item => {

      const {
        snapId,
        price,
        priceLow,
        priceHigh,
        name,
        game
      } = item;


      const resp =
        UrlFetchApp.fetch(

          `${SUPABASE_URL}/rest/v1/price_snapshots` +
          `?id=eq.${snapId}`,

          {

            method:
              "patch",

            headers: {

              "apikey":
                SUPABASE_KEY,

              "Authorization":
                `Bearer ${SUPABASE_KEY}`,

              "Content-Type":
                "application/json",

              "Prefer":
                "return=minimal"

            },

            payload:
              JSON.stringify({

                tcgplayer_market:
                  price,

                tcgplayer_low:
                  priceLow

              }),

            muteHttpExceptions:
              true

          }

        );


      if (
        resp.getResponseCode() === 204
      ) {

        Logger.log(
          `Updated ${game}: ${name} ` +
          `market=$${price} ` +
          `low=$${priceLow}`
        );

      } else {

        Logger.log(
          `Update failed for ${name}: ` +
          resp.getContentText()
        );

      }

    });

  } else {

    Logger.log(
      "No null-price snapshots to update"
    );

  }


  // ========================================================
  // COUNT SKIPPED
  // ========================================================

  const skippedCount =
    data.filter(row => {

      const [
        name,
        productId,
        marketPrice,
        rarity,
        setName,
        lowPrice,
        highPrice,
        gameName,
        foil
      ] = row;


      if (
        !productId ||
        !marketPrice
      ) {
        return false;
      }


      if (
        isSkippable_(name)
      ) {
        return false;
      }


      const cardId =
        productIdMap.get(
          printingKey_(productId, foil)
        );


      if (!cardId) {
        return false;
      }


      const existing =
        snapMap.get(cardId);


      return (
        existing &&
        existing.hasPrice
      );

    }).length;


  Logger.log(
    `Done! New: ${toInsert.length} | ` +
    `Updated: ${toUpdate.length} | ` +
    `Skipped: ${skippedCount}`
  );


  sendPriceUpdateEmail(
    toInsert.length,
    toUpdate.length,
    skippedCount
  );

}


// ============================================================
// EMAIL SUMMARY
// ============================================================

function sendPriceUpdateEmail(
  newSnapshots,
  updated,
  skipped
) {

  const now =
    new Date();


  const dateStr =
    Utilities.formatDate(
      now,
      "America/New_York",
      "EEEE, MMMM d, yyyy"
    );


  const timeStr =
    Utilities.formatDate(
      now,
      "America/New_York",
      "h:mm a z"
    );


  const html = `
<!DOCTYPE html>
<html>

<body
  style="
    background:#0A0908;
    color:#F0EAD6;
    font-family:-apple-system,sans-serif;
    margin:0;
    padding:0;
  "
>

<div
  style="
    max-width:600px;
    margin:0 auto;
    padding:32px 24px;
  "
>

  <div
    style="
      border-bottom:1px solid rgba(201,168,76,0.2);
      padding-bottom:20px;
      margin-bottom:24px;
    "
  >

    <div
      style="
        font-size:11px;
        letter-spacing:0.14em;
        text-transform:uppercase;
        color:#C9A84C;
        margin-bottom:6px;
      "
    >
      SatornTCG Market Manager
    </div>

    <h1
      style="
        margin:0;
        font-size:22px;
        font-weight:600;
      "
    >
      TCGPlayer Price Update
    </h1>

    <p
      style="
        margin:6px 0 0;
        font-size:13px;
        color:#9A9080;
      "
    >
      ${dateStr} · ${timeStr}
    </p>

  </div>


  <div
    style="
      background:#161411;
      border:1px solid rgba(201,168,76,0.1);
      border-radius:12px;
      padding:20px;
      margin-bottom:24px;
    "
  >

    <div
      style="
        display:grid;
        grid-template-columns:repeat(3,1fr);
        gap:12px;
        text-align:center;
      "
    >

      <div>

        <div
          style="
            font-size:28px;
            font-weight:300;
            color:#4CAF6E;
          "
        >
          ${newSnapshots}
        </div>

        <div
          style="
            font-size:10px;
            text-transform:uppercase;
            letter-spacing:0.1em;
            color:#5A5448;
            margin-top:4px;
          "
        >
          New snapshots
        </div>

      </div>


      <div>

        <div
          style="
            font-size:28px;
            font-weight:300;
            color:#4C84C9;
          "
        >
          ${updated}
        </div>

        <div
          style="
            font-size:10px;
            text-transform:uppercase;
            letter-spacing:0.1em;
            color:#5A5448;
            margin-top:4px;
          "
        >
          Updated
        </div>

      </div>


      <div>

        <div
          style="
            font-size:28px;
            font-weight:300;
            color:#9A9080;
          "
        >
          ${skipped}
        </div>

        <div
          style="
            font-size:10px;
            text-transform:uppercase;
            letter-spacing:0.1em;
            color:#5A5448;
            margin-top:4px;
          "
        >
          Skipped
        </div>

      </div>

    </div>

  </div>


  <div
    style="
      border-top:1px solid rgba(201,168,76,0.15);
      padding-top:16px;
    "
  >

    <p
      style="
        font-size:12px;
        color:#5A5448;
        margin:0;
      "
    >
      TCGPlayer prices via TCGCSV
      · Sorcery
      · Riftbound
    </p>

  </div>

</div>

</body>
</html>
`;


  GmailApp.sendEmail(

    "satorntcg@gmail.com",

    `🃏 TCGPlayer Update — ` +
    `${newSnapshots} new · ` +
    `${updated} updated · ` +
    `${skipped} skipped · ` +
    `${dateStr}`,

    `TCGPlayer Price Update\n` +
    `${newSnapshots} new, ` +
    `${updated} updated, ` +
    `${skipped} skipped.\n` +
    `${dateStr} ${timeStr}`,

    {
      htmlBody: html
    }

  );


  Logger.log(
    `Email sent — new: ${newSnapshots}, ` +
    `updated: ${updated}, ` +
    `skipped: ${skipped}`
  );

}


// ============================================================
// DEBUG
//
// Examples:
//
// debugCardPrice("Bureau of Occult Control (Foil)", "Sorcery");
//
// debugCardPrice("Jinx", "Riftbound");
//
// ============================================================

function debugCardPrice(
  cardName,
  gameName
) {

  Logger.log(
    `\n══ PRICE DEBUG: ` +
    `${gameName} / "${cardName}" ══`
  );


  const gameIdMap =
    getGameIdMap_();


  // Reverse map: games.id → TCG_GAMES key ("Sorcery"/"Riftbound"),
  // needed below to look back up each result's TCG_GAMES config.

  const gameIdToName =
    new Map();


  Object.keys(TCG_GAMES)
    .forEach(name => {

      const id =
        gameIdMap.get(
          name.toLowerCase()
        );


      if (id) {

        gameIdToName.set(
          id,
          name
        );

      }

    });


  let url =

    `${SUPABASE_URL}/rest/v1/cards` +
    `?name=ilike.${encodeURIComponent(cardName)}` +
    `&select=id,name,game_id,set_name,rarity,foil,tcgplayer_id` +
    `&limit=20`;


  if (gameName) {

    const gameId =
      gameIdMap.get(
        gameName.toLowerCase()
      );


    if (!gameId) {

      Logger.log(
        `❌ No Supabase games row for "${gameName}"`
      );

      return;

    }


    url +=
      `&game_id=eq.${gameId}`;

  }


  const cardsResp =
    UrlFetchApp.fetch(

      url,

      {

        headers: {

          "apikey":
            SUPABASE_KEY,

          "Authorization":
            `Bearer ${SUPABASE_KEY}`

        },

        muteHttpExceptions:
          true

      }

    );


  const cards =
    JSON.parse(
      cardsResp.getContentText()
    );


  if (!cards.length) {

    Logger.log(
      "❌ Card not found in Supabase"
    );

    return;

  }


  Logger.log(
    `✓ Found ${cards.length} match(es):`
  );


  cards.forEach(card => {

    const game =
      gameIdToName.get(card.game_id) ||
      gameName ||
      card.game_id;


    Logger.log(

      `Game: ${game} | ` +
      `Name: ${card.name} | ` +
      `Set: ${card.set_name} | ` +
      `Rarity: ${card.rarity} | ` +
      `Foil: ${card.foil} | ` +
      `TCG ID: ${card.tcgplayer_id || "❌ MISSING"}`

    );

  });


  cards.forEach(card => {

    Logger.log(
      `\n── Snapshots for "${card.name}" ──`
    );


    if (!card.tcgplayer_id) {

      Logger.log(
        "⚠ No tcgplayer_id"
      );

      return;

    }


    // ------------------------------------------------------
    // Historical snapshots
    // ------------------------------------------------------

    const snapResp =
      UrlFetchApp.fetch(

        `${SUPABASE_URL}/rest/v1/price_snapshots` +
        `?card_id=eq.${card.id}` +
        `&select=tcgplayer_market,tcgplayer_low,ebay_sold_avg,checked_at` +
        `&order=checked_at.desc` +
        `&limit=7`,

        {

          headers: {

            "apikey":
              SUPABASE_KEY,

            "Authorization":
              `Bearer ${SUPABASE_KEY}`

          },

          muteHttpExceptions:
            true

        }

      );


    const snaps =
      JSON.parse(
        snapResp.getContentText()
      );


    if (!snaps.length) {

      Logger.log(
        "❌ No snapshots found"
      );

    } else {

      snaps.forEach(snapshot => {

        const date =
          new Date(
            snapshot.checked_at
          )
            .toLocaleString(
              "en-US",
              {
                timeZone:
                  "America/New_York"
              }
            );


        const market =
          snapshot.tcgplayer_market != null
            ? `$${snapshot.tcgplayer_market}`
            : "null";


        const low =
          snapshot.tcgplayer_low != null
            ? `$${snapshot.tcgplayer_low}`
            : "null";


        const ebay =
          snapshot.ebay_sold_avg != null
            ? `$${snapshot.ebay_sold_avg}`
            : "null";


        Logger.log(
          `[${date}] ` +
          `Market: ${market} ` +
          `Low: ${low} ` +
          `eBay Avg: ${ebay}`
        );

      });

    }


    // ------------------------------------------------------
    // Live TCGCSV lookup
    // ------------------------------------------------------

    Logger.log(
      `\nLive TCGCSV check ` +
      `(productId: ${card.tcgplayer_id})`
    );


    try {

      const game =
        gameIdToName.get(card.game_id) ||
        gameName;


      const config =
        TCG_GAMES[game];


      if (!config) {

        Logger.log(
          `❌ Unknown game configuration: ${game}`
        );

        return;

      }


      const categoryId =
        findCategoryId_(
          config.category
        );


      const groups =
        getTargetGroups_(
          categoryId,
          config.sets
        );


      let found = false;


      groups.forEach(group => {

        if (found) {
          return;
        }


        const prices =
          (
            fetchJson_(
              `${TCGCSV_BASE}/${categoryId}/${group.groupId}/prices`
            )
          ).results || [];


        const match =
          prices.find(price =>
            String(price.productId) ===
            String(card.tcgplayer_id)
          );


        if (!match) {
          return;
        }


        found = true;


        Logger.log(
          `✓ Game: ${game}`
        );


        Logger.log(
          `✓ Set: ${group.name}`
        );


        Logger.log(
          `Market: ${
            match.marketPrice != null
              ? "$" + match.marketPrice
              : "null"
          }`
        );


        Logger.log(
          `Low: ${
            match.lowPrice != null
              ? "$" + match.lowPrice
              : "null"
          }`
        );


        Logger.log(
          `High: ${
            match.highPrice != null
              ? "$" + match.highPrice
              : "null"
          }`
        );


        Logger.log(
          `Mid: ${
            match.midPrice != null
              ? "$" + match.midPrice
              : "null"
          }`
        );


        // Liquidity signal

        if (
          match.marketPrice &&
          match.highPrice
        ) {

          const ratio =
            match.highPrice /
            match.marketPrice;


          if (ratio > 2.5) {

            Logger.log(
              `⚠ HIGH SPREAD ` +
              `(high/market = ${ratio.toFixed(1)}x) ` +
              `— low volume likely`
            );

          }

        }

      });


      if (!found) {

        Logger.log(
          "❌ productId not found in configured TCGCSV sets"
        );

      }

    } catch (error) {

      Logger.log(
        `❌ TCGCSV fetch error: ${error.message}`
      );

    }

  });


  Logger.log(
    "\n══ END DEBUG ══"
  );

}


// ============================================================
// DEBUG TEST
// ============================================================

function runDebug() {

  debugCardPrice(
    "Bureau of Occult Control (Foil)",
    "Sorcery"
  );

  // Riftbound example:
  //
  // debugCardPrice(
  //   "Jinx",
  //   "Riftbound"
  // );

}


// ============================================================
// SEED CARDS
//
// Run manually.
//
// Safe to re-run.
//
// Inserts both:
//   • Sorcery
//   • Riftbound
//
// ============================================================

function seedCardsFromTcgPlayer() {

  Logger.log(
    "========================================"
  );

  Logger.log(
    "STARTING MULTI-GAME CARD SEED"
  );

  Logger.log(
    "========================================"
  );


  // ========================================================
  // Resolve game_id for each configured game up front
  // ========================================================

  const gameIdMap =
    getGameIdMap_();


  // ========================================================
  // Load existing cards
  // ========================================================

  const existingCards = [];

  let from = 0;

  const pageSize = 1000;


  while (true) {

    const resp =
      UrlFetchApp.fetch(

        `${SUPABASE_URL}/rest/v1/cards` +
        `?select=name,game_id,tcgplayer_id,foil` +
        `&limit=${pageSize}` +
        `&offset=${from}`,

        {

          headers: {

            "apikey":
              SUPABASE_KEY,

            "Authorization":
              `Bearer ${SUPABASE_KEY}`

          },

          muteHttpExceptions:
            true

        }

      );


    if (
      resp.getResponseCode() < 200 ||
      resp.getResponseCode() >= 300
    ) {

      throw new Error(
        "Unable to load existing cards: " +
        resp.getContentText()
      );

    }


    const page =
      JSON.parse(
        resp.getContentText()
      );


    if (!page.length) {
      break;
    }


    existingCards.push(
      ...page
    );


    if (page.length < pageSize) {
      break;
    }


    from += pageSize;

  }


  // ========================================================
  // Duplicate protection
  //
  // Keyed by productId+foil (a "printing"), not just productId —
  // Riftbound-style games sell Normal + Foil under the SAME
  // productId, so two DIFFERENT cards rows can share one tcgplayer_id.
  // ========================================================

  const existingPrintings =
    new Set();


  const existingGameNames =
    new Set();


  existingCards.forEach(card => {

    if (card.tcgplayer_id) {

      existingPrintings.add(
        printingKey_(
          card.tcgplayer_id,
          card.foil
        )
      );

    }


    if (card.name && card.game_id) {

      existingGameNames.add(

        `${card.game_id}` +
        `|${card.name.toLowerCase().trim()}` +
        `|${Boolean(card.foil)}`

      );

    }

  });


  Logger.log(
    `Existing cards in Supabase: ` +
    `${existingCards.length}`
  );


  let totalInserted = 0;

  let totalFailed = 0;

  let totalDupe = 0;

  let totalNoRarity = 0;

  let totalSkipped = 0;


  // ========================================================
  // LOOP GAMES
  // ========================================================

  Object.entries(TCG_GAMES)
    .forEach(([gameName, config]) => {


      Logger.log("");
      Logger.log(
        `========== SEEDING ${gameName.toUpperCase()} ==========`
      );


      const gameId =
        gameIdMap.get(
          gameName.toLowerCase()
        );


      if (!gameId) {

        Logger.log(
          `❌ No Supabase games row for "${gameName}" — ` +
          `add it to the games table first`
        );

        return;

      }


      const categoryId =
        findCategoryId_(
          config.category
        );


      if (!categoryId) {

        Logger.log(
          `❌ ${gameName} category not found`
        );

        return;

      }


      const targetGroups =
        getTargetGroups_(
          categoryId,
          config.sets
        );


      // ====================================================
      // LOOP SETS
      // ====================================================

      targetGroups.forEach(group => {

        const {
          groupId,
          name: setName
        } = group;


        Logger.log(
          `\n── Seeding ${gameName}: ${setName} ──`
        );


        const products =
          (
            fetchJson_(
              `${TCGCSV_BASE}/${categoryId}/${groupId}/products`
            )
          ).results || [];


        // productId → array of subTypeName strings seen in pricing data
        // ("Normal", "Foil", ...). Whether each one counts as foil is
        // decided below, once the product's own name is in scope too —
        // Sorcery's foil cards are separate productIds whose *name* says
        // "(Foil)", not their subTypeName, so subTypeName alone isn't
        // enough to classify a printing correctly for every game.
        const subTypesByProduct =
          new Map();


        (
          fetchJson_(
            `${TCGCSV_BASE}/${categoryId}/${groupId}/prices`
          )
        ).results?.forEach(price => {

          if (!price.productId) {
            return;
          }


          if (!subTypesByProduct.has(price.productId)) {
            subTypesByProduct.set(price.productId, []);
          }


          subTypesByProduct
            .get(price.productId)
            .push(price.subTypeName || "");

        });


        const toInsert = [];


        products.forEach(product => {

          const name =
            (product.name || "").trim();


          const productId =
            String(
              product.productId || ""
            ).trim();


          if (
            !name ||
            !productId
          ) {
            return;
          }


          // ------------------------------------------------
          // Sealed/accessory filtering
          // ------------------------------------------------

          if (
            isSkippable_(name)
          ) {

            totalSkipped++;

            return;

          }


          // ------------------------------------------------
          // Rarity — skip rather than insert a NOT NULL
          // violation. cards.rarity has no default, so a
          // product with no rarity data cannot be inserted.
          // ------------------------------------------------

          const tcgRarity =
            getRarity_(product);


          const rarity =
            normalizeRarity_(
              gameName,
              tcgRarity
            );


          if (!rarity) {

            Logger.log(
              `⚠ Skipping (no rarity): ` +
              `${gameName} / "${name}"`
            );

            totalNoRarity++;

            return;

          }


          // ------------------------------------------------
          // Printings — usually just one, decided from the name
          // (Sorcery-style). If pricing data shows more than one
          // subTypeName for this productId (Riftbound-style Normal
          // + Foil sharing a productId), that becomes two printings.
          // ------------------------------------------------

          const subTypes =
            subTypesByProduct.get(product.productId) || [""];


          const printings =
            new Set(
              subTypes.map(subType =>
                isFoilPrinting_(subType, name)
              )
            );


          printings.forEach(isFoil => {

            // ----------------------------------------------
            // Per-printing duplicate check
            // ----------------------------------------------

            if (
              existingPrintings.has(
                printingKey_(productId, isFoil)
              )
            ) {

              totalDupe++;

              return;

            }


            const gameNameKey =

              `${gameId}` +
              `|${name.toLowerCase()}` +
              `|${isFoil}`;


            if (
              existingGameNames.has(gameNameKey)
            ) {

              totalDupe++;

              return;

            }


            // ------------------------------------------------
            // Insert object
            // ------------------------------------------------

            toInsert.push({

              game_id:
                gameId,

              name:
                name,

              set_name:
                setName,

              set_code:
                mapSetCode_(
                  gameName,
                  setName
                ),

              rarity:
                rarity,

              foil:
                isFoil,

              tcgplayer_id:
                productId,

              image_url:
                product.imageUrl || null

            });


            // Prevent duplicates during same run

            existingPrintings.add(
              printingKey_(productId, isFoil)
            );


            existingGameNames.add(
              gameNameKey
            );

          });

        });


        Logger.log(
          `${toInsert.length} cards to insert`
        );


        // --------------------------------------------------
        // Batch insert
        // --------------------------------------------------

        for (
          let i = 0;
          i < toInsert.length;
          i += 50
        ) {

          const batch =
            toInsert.slice(
              i,
              i + 50
            );


          const resp =
            UrlFetchApp.fetch(

              `${SUPABASE_URL}/rest/v1/cards`,

              {

                method:
                  "post",

                headers: {

                  "apikey":
                    SUPABASE_KEY,

                  "Authorization":
                    `Bearer ${SUPABASE_KEY}`,

                  "Content-Type":
                    "application/json",

                  "Prefer":
                    "return=minimal"

                },

                payload:
                  JSON.stringify(batch),

                muteHttpExceptions:
                  true

              }

            );


          if (
            resp.getResponseCode() === 201
          ) {

            Logger.log(
              `✓ Inserted ${batch.length}`
            );

            totalInserted +=
              batch.length;

          } else {

            Logger.log(
              `✗ Batch failed: ` +
              resp.getContentText()
            );

            totalFailed +=
              batch.length;

          }

        }

      });

    });


  Logger.log("");
  Logger.log(
    "══ SEED COMPLETE ══"
  );


  Logger.log(
    `Inserted:              ${totalInserted}`
  );


  Logger.log(
    `Duplicates skipped:    ${totalDupe}`
  );


  Logger.log(
    `Products skipped:      ${totalSkipped}`
  );


  Logger.log(
    `No rarity:             ${totalNoRarity}`
  );


  Logger.log(
    `Failed:                ${totalFailed}`
  );

}


// ============================================================
// HELPER
//
// Load games table once → Map of lowercased slug/name → game_id.
//
// TCG_GAMES keys ("Sorcery", "Riftbound") match the games.slug
// values ("sorcery", "riftbound") when lowercased, so
// gameIdMap.get(gameName.toLowerCase()) resolves cleanly.
// ============================================================

function getGameIdMap_() {

  const resp =
    UrlFetchApp.fetch(

      `${SUPABASE_URL}/rest/v1/games` +
      `?select=id,name,slug`,

      {

        headers: {

          "apikey":
            SUPABASE_KEY,

          "Authorization":
            `Bearer ${SUPABASE_KEY}`

        },

        muteHttpExceptions: true

      }

    );


  if (
    resp.getResponseCode() < 200 ||
    resp.getResponseCode() >= 300
  ) {

    throw new Error(
      "Unable to load games: " +
      resp.getContentText()
    );

  }


  const games =
    JSON.parse(
      resp.getContentText()
    );


  const map = new Map();


  games.forEach(g => {

    if (g.slug) {
      map.set(g.slug.toLowerCase(), g.id);
    }

    if (g.name) {
      map.set(g.name.toLowerCase(), g.id);
    }

  });


  return map;

}


// ============================================================
// HELPER
//
// Find TCGplayer / TCGCSV category
// ============================================================

function findCategoryId_(keyword) {

  const data =
    fetchJson_(
      `${TCGCSV_BASE}/categories`
    );


  const k =
    keyword
      .toLowerCase();


  return (
    data.results || []
  ).find(category =>

    (
      category.displayName || ""
    )
      .toLowerCase()
      .includes(k)

    ||

    (
      category.name || ""
    )
      .toLowerCase()
      .includes(k)

  )?.categoryId || null;

}


// ============================================================
// HELPER
//
// Get configured groups for a game
// ============================================================

function getTargetGroups_(
  categoryId,
  sets
) {

  const groupsData =
    fetchJson_(
      `${TCGCSV_BASE}/${categoryId}/groups`
    );


  return (
    groupsData.results || []
  ).filter(group => {

    const name =
      (group.name || "")
        .toLowerCase();


    return sets.some(set =>

      name.includes(
        set.toLowerCase()
      )

    );

  });

}


// ============================================================
// HELPER
//
// HTTP GET JSON
// ============================================================

function fetchJson_(url) {

  const res =
    UrlFetchApp.fetch(

      url,

      {

        method:
          "get",

        headers: {

          "Accept":
            "application/json",

          // tcgcsv.com started rejecting requests without an identifying
          // User-Agent on 2026-09-18 ("Your User-Agent has been blocked").
          "User-Agent":
            "SatornTCG-PricePipeline/1.0"

        },

        muteHttpExceptions:
          true

      }

    );


  if (
    res.getResponseCode() !== 200
  ) {

    throw new Error(

      `Failed request ` +
      `(${res.getResponseCode()}): ` +
      `${url}\n` +
      res.getContentText()

    );

  }


  return JSON.parse(
    res.getContentText()
  );

}


// ============================================================
// HELPER
//
// Read rarity from TCGCSV product
// ============================================================

function getRarity_(product) {

  if (
    product.rarity
  ) {

    return product.rarity;

  }


  const extended =
    product.extendedData || [];


  const rarityField =
    extended.find(item =>

      (
        item.name || ""
      )
        .toLowerCase() ===
        "rarity"

      ||

      (
        item.displayName || ""
      )
        .toLowerCase() ===
        "rarity"

    );


  return rarityField?.value || "";

}


// ============================================================
// HELPER
//
// Normalize rarity depending on game.
//
// Sorcery retains your existing:
// ordinary / exceptional / elite / unique
//
// Riftbound keeps its native rarity value.
//
// ============================================================

function normalizeRarity_(
  gameName,
  tcgRarity
) {

  const rarity =
    (tcgRarity || "")
      .toLowerCase()
      .trim();


  if (!rarity) {
    return null;
  }


  // --------------------------------------------------------
  // Sorcery
  // --------------------------------------------------------

  if (
    gameName === "Sorcery"
  ) {

    if (
      rarity.includes("unique")
    ) {
      return "unique";
    }


    if (
      rarity.includes("elite")
    ) {
      return "elite";
    }


    if (
      rarity.includes("exceptional")
    ) {
      return "exceptional";
    }


    return "ordinary";

  }


  // --------------------------------------------------------
  // Riftbound
  //
  // Keep TCGplayer rarity instead of converting it to
  // Sorcery terminology.
  // --------------------------------------------------------

  if (
    gameName === "Riftbound"
  ) {

    return rarity;

  }


  return rarity;

}


// ============================================================
// HELPER
//
// Set codes
//
// Existing Sorcery codes are preserved.
//
// Origins = OGN.
//
// Other Riftbound codes are intentionally left null for now
// rather than guessing.
//
// ============================================================

function mapSetCode_(
  gameName,
  setName
) {

  const s =
    (setName || "")
      .toLowerCase();


  // --------------------------------------------------------
  // Sorcery
  // --------------------------------------------------------

  if (
    gameName === "Sorcery"
  ) {

    if (
      s.includes("gothic")
    ) {
      return "GOT";
    }


    if (
      s.includes("arthurian")
    ) {
      return "ARL";
    }


    if (
      s.includes("beta")
    ) {
      return "BET";
    }


    if (
      s.includes("alpha")
    ) {
      return "ALP";
    }


    if (
      s.includes("promo")
    ) {
      return "PRM";
    }


    return null;

  }


  // --------------------------------------------------------
  // Riftbound
  // --------------------------------------------------------

  if (
    gameName === "Riftbound"
  ) {

    if (
      s.includes("origins")
    ) {
      return "OGN";
    }


    // Add official codes here once desired:
    //
    // if (s.includes("spiritforged")) return "...";
    // if (s.includes("unleashed"))    return "...";
    // if (s.includes("vendetta"))     return "...";

    return null;

  }


  return null;

}


// ============================================================
// HELPER
//
// Is this printing (a price row's subTypeName, plus the product's
// own name as a fallback) the foil version of a card?
//
// Sorcery encodes foil in the product NAME ("(Foil)") since foil
// cards are entirely separate TCGplayer productIds. Riftbound (like
// Pokémon) encodes it in the pricing subTypeName ("Foil") instead,
// since Normal + Foil share one productId. Checking both covers
// either convention without needing to know which game called it.
// ============================================================

function isFoilPrinting_(subTypeName, name) {

  return (
    /foil/i.test(subTypeName || "") ||
    /\(foil\)/i.test(name || "")
  );

}


// ============================================================
// HELPER
//
// Key identifying one specific printing of a card: its TCGplayer
// productId PLUS whether it's foil. Needed because Riftbound-style
// games can have two different `cards` rows (Normal/Foil) sharing
// the exact same productId — bare productId isn't unique enough to
// match a sheet row (or a price snapshot) back to the right card.
// ============================================================

function printingKey_(productId, foil) {

  return (
    `${String(productId).trim()}` +
    `|${foil ? "foil" : "normal"}`
  );

}


// ============================================================
// HELPER
//
// Ignore sealed / non-card products
// ============================================================

function isSkippable_(name) {

  const lower =
    String(name || "")
      .toLowerCase();


  return SKIP_KEYWORDS.some(
    keyword =>
      lower.includes(keyword)
  );

}
