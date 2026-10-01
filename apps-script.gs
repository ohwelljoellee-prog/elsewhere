/**
 * Elsewhere POS — Apps Script backend
 * Writes each order into the "Purchase_orders" table on Sheet1 of the
 * "elsewhere orders" spreadsheet. Reached over fetch() from index.html
 * (running anywhere — localhost, a hosted page, etc.) via doPost below.
 *
 * Table layout (headers on row 2, data from row 3):
 *   A: done checkbox | B: # | C: name | D: drink | E: milk selection | F: time | G: phone number (left blank, no longer collected) | H: Notes (unused by this script)
 * One row per drink; drinks in the same order share an order number, which is also
 * the number shown to the customer on the confirmation screen (index.html reads it
 * back from this script's response — the two are always the same number).
 */

const SPREADSHEET_ID = "1D9x6xpV8-jjTUdHYVQf44TSXxGDXl-yl82jTIpNJqxA";
const SHEET_NAME = "Sheet1";
const FIRST_DATA_ROW = 3;   // row 2 holds the table headers
const COL_NUM = 2;          // column B (#) — writes B..G
const WRITE_WIDTH = 6;      // #, name, drink, milk, time, phone

// Drink/milk label sent by the POS page (index.html)  ->  value in the sheet's dropdown
const DRINKS = {
  "iced matcha latte": "matcha",
  "strawberry matcha latte": "stw mtch",
  "iced hojicha latte": "hojicha",
  "strawberry hojicha latte": "stw hoji"
};
const MILKS = { "oat": "oat", "whole": "whole" };

// Duplicate guard: the same order (same name + drinks) arriving again within
// this many seconds of the last copy is NOT written again — the original order
// # is returned instead. Stops page retries / double taps from creating repeat
// orders.
const DEDUPE_WINDOW_SECONDS = 300;

/** Serves the POS page, if it's ever uploaded into this Apps Script project as "index". */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("Elsewhere POS")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/** Reached by index.html's fetch(APPS_SCRIPT_URL, {method:"POST", ...}). */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // index.html sends one entry per cart line with a qty — expand to one entry per drink.
    const items = [];
    (body.items || []).forEach(function (it) {
      const qty = Math.max(1, Number(it.qty) || 1);
      for (let i = 0; i < qty; i++) items.push({ drink: it.drink, milk: it.milk });
    });

    const result = submitOrder({ name: body.name, items: items });

    return ContentService
      .createTextOutput(JSON.stringify({ status: "success", orderNumber: result.orderNumber, count: result.count }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/** Core order-writing logic, also callable directly via google.script.run.submitOrder(order). */
function submitOrder(order) {
  const name = String(order.name || "").trim();
  const items = Array.isArray(order.items) ? order.items : [];

  if (!name) throw new Error("Name is required.");
  if (items.length === 0) throw new Error("Add at least one drink.");
  items.forEach(function (it) {
    if (!DRINKS[it.drink]) throw new Error("Unknown drink: " + it.drink);
    if (!MILKS[it.milk]) throw new Error("Unknown milk: " + it.milk);
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // stops two tills from getting the same order number
  try {
    // Already got this exact order recently? Return the same order # and write nothing.
    const cache = CacheService.getScriptCache();
    const dedupeKey = dedupeKey_(name, items);
    const seen = cache.get(dedupeKey);
    if (seen) {
      cache.put(dedupeKey, seen, DEDUPE_WINDOW_SECONDS); // keep blocking while retries continue
      const prev = JSON.parse(seen);
      return { orderNumber: prev.orderNumber, count: prev.count, duplicate: true };
    }

    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Tab "' + SHEET_NAME + '" not found.');

    const orderNumber = nextOrderNumber_(sheet);
    const placed = new Date();
    const rows = items.map(function (it) {
      return [orderNumber, name, DRINKS[it.drink], MILKS[it.milk], placed, ""];
    });

    const startRow = findEmptyRows_(sheet, rows.length);
    sheet.getRange(startRow, COL_NUM, rows.length, WRITE_WIDTH).setValues(rows);
    // No setNumberFormat call here: the time column (F) is a typed column, and Sheets
    // rejects setNumberFormat() on typed columns — it renders the Date value on its own.

    SpreadsheetApp.flush();
    const result = { orderNumber: orderNumber, count: rows.length };
    cache.put(dedupeKey, JSON.stringify(result), DEDUPE_WINDOW_SECONDS);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Fingerprint of an order: name + sorted drink/milk list. */
function dedupeKey_(name, items) {
  const raw = name.toLowerCase() + "|" +
    items.map(function (it) { return it.drink + "/" + it.milk; }).sort().join(",");
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  return "order_" + Utilities.base64EncodeWebSafe(digest);
}

/** Next order # = one more than the highest # already in column B (starts at 1). */
function nextOrderNumber_(sheet) {
  const last = sheet.getLastRow();
  let max = 0;
  if (last >= FIRST_DATA_ROW) {
    sheet.getRange(FIRST_DATA_ROW, COL_NUM, last - FIRST_DATA_ROW + 1, 1).getValues()
      .forEach(function (r) { const n = Number(r[0]); if (n > max) max = n; });
  }
  return max + 1;
}

/**
 * Returns the first row of a run of `count` blank rows inside the table
 * (a row is blank when B..G are empty). Adds rows to the bottom if the table is full.
 */
function findEmptyRows_(sheet, count) {
  const last = Math.max(sheet.getLastRow(), FIRST_DATA_ROW);
  const values = sheet.getRange(FIRST_DATA_ROW, COL_NUM, last - FIRST_DATA_ROW + 1, WRITE_WIDTH).getValues();

  // Start after the last filled row so orders stay in order.
  let lastFilled = -1;
  values.forEach(function (r, i) { if (r.join("") !== "") lastFilled = i; });
  const start = FIRST_DATA_ROW + lastFilled + 1;
  const free = last - start + 1;

  if (free < count) {
    const need = count - free;
    sheet.insertRowsAfter(last, need);
    // Carry the table's formatting, dropdowns and checkbox into the new rows.
    const template = sheet.getRange(last, 1, 1, sheet.getLastColumn());
    const target = sheet.getRange(last + 1, 1, need, sheet.getLastColumn());
    template.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    template.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    sheet.getRange(last + 1, 1, need, 1).insertCheckboxes();
  }
  return start;
}
