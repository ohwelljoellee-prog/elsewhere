/**
 * Elsewhere POS — Apps Script backend
 *
 * Lives in the existing "elsewhere orders" spreadsheet and has three jobs:
 *   1. Orders: POS (index.html) POSTs an order; each drink becomes one row on that day's tab.
 *   2. Menu:   POS GETs ?action=menu to load the drinks, milks and options it shows.
 *   3. Admin:  ?page=admin serves the password-protected admin page (admin.html).
 *              Adding a drink, milk or option writes a full row to its tab.
 *
 * Orders tabs: "Sheet1" is the template and keeps older orders. The first order of each day
 * creates a tab named for that day (e.g. "2026-10-05") with the same layout. Order numbers
 * start at 1 on each day's tab.
 *   A: # | B: name | C: drink | D: milk | E: time | F: phone (optional) | G: Notes
 *   Notes holds the chosen options, e.g. "sweetness: half sugar; size: large".
 *
 * Menu tabs (headers on row 1, one row per item; hidden items keep their row):
 *   Drinks:  id | name | group | photo_url | sheet_label | active | sort | created_at | updated_at
 *   Milks:   id | label | sheet_label | active | sort | created_at | updated_at
 *   Options: id | group | label | sheet_label | active | sort | created_at | updated_at
 *            (a group such as "sweetness" is just the text you type; there is no separate list)
 *
 * One-time setup: run setupMenuTabs_() and setAdminPassword_() from the editor (see SETUP.md).
 */

const SPREADSHEET_ID = "1D9x6xpV8-jjTUdHYVQf44TSXxGDXl-yl82jTIpNJqxA";
const ORDERS_SHEET = "Sheet1";     // template for the daily tabs
const DAY_TAB_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DRINKS_SHEET = "Drinks";
const MILKS_SHEET = "Milks";
const OPTIONS_SHEET = "Options";
const FIRST_DATA_ROW = 3;   // Orders tabs: row 2 holds the table headers
const COL_NUM = 1;          // Orders tabs column A (#) — writes A..G
const WRITE_WIDTH = 7;      // #, name, drink, milk, time, phone, notes
const COL_DRINK_DROPDOWN = 3; // Orders tabs column C
const COL_MILK_DROPDOWN = 4;  // Orders tabs column D

// Duplicate guard: the same order arriving again within this many seconds is not written twice.
const DEDUPE_WINDOW_SECONDS = 300;
const MENU_CACHE_SECONDS = 60;
const ADMIN_SESSION_SECONDS = 6 * 60 * 60;
const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCK_SECONDS = 15 * 60;

/* ------------------------------------------------------------------ */
/* Web app entry points                                                */
/* ------------------------------------------------------------------ */

/** GET ?action=menu → menu JSON for the POS. GET ?page=admin → admin page. */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action === "menu") {
    return json_({ status: "success", menu: publicMenu_() });
  }
  if (params.page === "admin") {
    return HtmlService.createHtmlOutputFromFile("admin")
      .setTitle("Elsewhere Admin")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }
  return json_({ status: "success", message: "Elsewhere POS backend is running." });
}

/** Reached by index.html's fetch(APPS_SCRIPT_URL, {method:"POST", ...}). */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // index.html sends one entry per cart line with a qty — expand to one entry per drink.
    const items = [];
    (body.items || []).forEach(function (it) {
      const qty = Math.max(1, Number(it.qty) || 1);
      for (let i = 0; i < qty; i++) items.push(it);
    });

    const result = submitOrder({ name: body.name, phone: body.phone, items: items });
    return json_({ status: "success", orderNumber: result.orderNumber, count: result.count });
  } catch (err) {
    return json_({ status: "error", message: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

/**
 * Core order-writing logic. Each item is { drinkId | drink, milkId | milk, options: [optionId], qty }.
 * Rows go on today's tab (see dayOrdersSheet_), so order numbers restart each day.
 */
function submitOrder(order) {
  const name = String(order.name || "").trim();
  const phone = String(order.phone || "").trim(); // optional
  const items = Array.isArray(order.items) ? order.items : [];
  if (!name) throw new Error("Name is required.");
  if (items.length === 0) throw new Error("Add at least one drink.");

  const menu = readMenu_(); // all rows, including hidden ones, so orders queued earlier still sync
  const resolved = items.map(function (it) { return resolveItem_(menu, it); });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // stops two tills from getting the same order number
  try {
    const placed = new Date();
    const tabName = dayTabName_(placed);

    const cache = CacheService.getScriptCache();
    const dedupeKey = dedupeKey_(tabName, name, resolved);
    const seen = cache.get(dedupeKey);
    if (seen) {
      cache.put(dedupeKey, seen, DEDUPE_WINDOW_SECONDS);
      const prev = JSON.parse(seen);
      return { orderNumber: prev.orderNumber, count: prev.count, duplicate: true };
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = dayOrdersSheet_(ss, tabName, menu);

    const orderNumber = nextOrderNumber_(sheet);
    const rows = resolved.map(function (r) {
      return [orderNumber, name, r.drink.sheet_label, r.milk.sheet_label, placed, phone, r.notes];
    });

    const startRow = findEmptyRows_(sheet, rows.length);
    sheet.getRange(startRow, COL_NUM, rows.length, WRITE_WIDTH).setValues(rows);
    SpreadsheetApp.flush();

    const result = { orderNumber: orderNumber, count: rows.length, tab: tabName };
    cache.put(dedupeKey, JSON.stringify(result), DEDUPE_WINDOW_SECONDS);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Tab name for the day an order is placed, e.g. "2026-10-05", in the script's time zone. */
function dayTabName_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/**
 * Returns the orders tab for one day, creating it on the first order of that day.
 * The new tab is a copy of Sheet1, so it keeps the headers, formatting and dropdowns,
 * but without Sheet1's orders. Call under the script lock.
 */
function dayOrdersSheet_(ss, tabName, menu) {
  const existing = ss.getSheetByName(tabName);
  if (existing) return existing;

  const template = ss.getSheetByName(ORDERS_SHEET);
  if (!template) throw new Error('Tab "' + ORDERS_SHEET + '" not found.');
  const sheet = template.copyTo(ss).setName(tabName);

  const dataRows = sheet.getMaxRows() - FIRST_DATA_ROW + 1;
  sheet.getRange(FIRST_DATA_ROW, 1, dataRows, sheet.getMaxColumns()).clearContent();
  setOrderDropdowns_(sheet, menu);
  return sheet;
}

/** Finds the drink, milk and options for one order line. Prefers ids; falls back to the old name/label fields. */
function resolveItem_(menu, it) {
  const drink = menu.drinks.find(function (d) { return d.id === it.drinkId; }) ||
                menu.drinks.find(function (d) { return d.name === it.drink; });
  const milk = menu.milks.find(function (m) { return m.id === it.milkId; }) ||
               menu.milks.find(function (m) { return m.id === it.milk; });
  if (!drink) throw new Error("Unknown drink: " + (it.drinkId || it.drink));
  if (!milk) throw new Error("Unknown milk: " + (it.milkId || it.milk));
  const options = resolveOptions_(menu, it.options);
  const notes = options.map(function (o) { return o.group + ": " + o.sheet_label; }).join("; ");
  return { drink: drink, milk: milk, options: options, notes: notes };
}

/** Option ids chosen on one line, looked up in the menu. Unknown ids are rejected. */
function resolveOptions_(menu, ids) {
  return (Array.isArray(ids) ? ids : []).map(function (id) {
    const opt = menu.options.find(function (o) { return o.id === String(id); });
    if (!opt) throw new Error("Unknown option: " + id);
    return opt;
  });
}

/** Fingerprint of an order: day tab + name + sorted drink/milk/option ids. */
function dedupeKey_(tabName, name, resolved) {
  const raw = tabName + "|" + name.toLowerCase() + "|" + resolved.map(function (r) {
    return r.drink.id + "/" + r.milk.id + "/" + r.options.map(function (o) { return o.id; }).sort().join("+");
  }).sort().join(",");
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

  let lastFilled = -1;
  values.forEach(function (r, i) { if (r.join("") !== "") lastFilled = i; });
  const start = FIRST_DATA_ROW + lastFilled + 1;
  const free = last - start + 1;

  if (free < count) {
    const need = count - free;
    sheet.insertRowsAfter(last, need);
    // Carry the table's formatting and dropdowns into the new rows.
    const template = sheet.getRange(last, 1, 1, sheet.getLastColumn());
    // copyTo fills only the source's size, so copy the template into each new row.
    for (let i = 0; i < need; i++) {
      const target = sheet.getRange(last + 1 + i, 1, 1, sheet.getLastColumn());
      template.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      template.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    }
  }
  return start;
}

/* ------------------------------------------------------------------ */
/* Menu (read)                                                         */
/* ------------------------------------------------------------------ */

/** Full menu from the sheets, including hidden items. Cached briefly. */
function getMenu_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("menu");
  if (cached) return JSON.parse(cached);
  const menu = readMenu_();
  cache.put("menu", JSON.stringify(menu), MENU_CACHE_SECONDS);
  return menu;
}

function readMenu_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const drinks = readTable_(ss.getSheetByName(DRINKS_SHEET), DRINKS_SHEET)
    .map(function (r) {
      return { id: String(r.id), name: String(r.name), group: String(r.group || ""), photo_url: String(r.photo_url || ""),
               sheet_label: String(r.sheet_label), active: isTrue_(r.active), sort: Number(r.sort) || 0 };
    });
  const milks = readTable_(ss.getSheetByName(MILKS_SHEET), MILKS_SHEET)
    .map(function (r) {
      return { id: String(r.id), label: String(r.label), sheet_label: String(r.sheet_label),
               active: isTrue_(r.active), sort: Number(r.sort) || 0 };
    });
  // Options tab is optional until setupMenuTabs_() has run, so the menu still loads without it.
  const options = (ss.getSheetByName(OPTIONS_SHEET) ? readTable_(ss.getSheetByName(OPTIONS_SHEET), OPTIONS_SHEET) : [])
    .map(function (r) {
      return { id: String(r.id), group: String(r.group), label: String(r.label), sheet_label: String(r.sheet_label),
               active: isTrue_(r.active), sort: Number(r.sort) || 0 };
    });
  drinks.sort(bySort_);
  milks.sort(bySort_);
  options.sort(bySort_);
  return { drinks: drinks, milks: milks, options: options };
}

/** What the POS is allowed to see: active items only, no sheet labels. */
function publicMenu_() {
  const menu = getMenu_();
  return {
    drinks: menu.drinks.filter(function (d) { return d.active; })
      .map(function (d) { return { id: d.id, name: d.name, group: d.group, photo: d.photo_url }; }),
    milks: menu.milks.filter(function (m) { return m.active; })
      .map(function (m) { return { id: m.id, label: m.label }; }),
    options: menu.options.filter(function (o) { return o.active; })
      .map(function (o) { return { id: o.id, group: o.group, label: o.label }; })
  };
}

/** Rows of a tab as objects keyed by the header in row 1. Skips rows with no id. */
function readTable_(sheet, name) {
  if (!sheet) throw new Error('Tab "' + name + '" not found. Run setupMenuTabs_() from the editor.');
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return sheet.getRange(2, 1, last - 1, headers.length).getValues()
    .map(function (row) {
      const o = {};
      headers.forEach(function (h, i) { o[String(h)] = row[i]; });
      return o;
    })
    .filter(function (o) { return String(o.id || "") !== ""; });
}

function bySort_(a, b) { return a.sort - b.sort; }
function isTrue_(v) { return v === true || String(v).toUpperCase() === "TRUE"; }

/* ------------------------------------------------------------------ */
/* Admin auth                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run once from the editor to set the admin password. The password is NOT in this file
 * (the repo is public). Add it first in the editor: Project Settings → Script Properties →
 * add NEW_ADMIN_PASSWORD. Then run this function. Only a salted hash is stored.
 * Afterwards, delete the NEW_ADMIN_PASSWORD property.
 * The trailing underscore keeps it out of google.script.run, so the admin page can't call it.
 */
function setAdminPassword_() {
  const password = PropertiesService.getScriptProperties().getProperty("NEW_ADMIN_PASSWORD");
  if (!password) throw new Error("Add NEW_ADMIN_PASSWORD under Script Properties first.");
  const salt = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({
    ADMIN_SALT: salt,
    ADMIN_HASH: hashPassword_(password, salt)
  }, false);
  Logger.log("Admin password stored.");
}

function hashPassword_(password, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ":" + password);
  return digest.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
}

/** Checks the password and returns a session token that lasts ADMIN_SESSION_SECONDS. */
function adminLogin(password) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("admin_fails") || 0);
  if (fails >= MAX_FAILED_LOGINS) throw new Error("Too many wrong passwords. Wait 15 minutes and try again.");

  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty("ADMIN_SALT");
  const hash = props.getProperty("ADMIN_HASH");
  if (!salt || !hash) throw new Error("Admin password not set. Run setAdminPassword_() first.");

  if (hashPassword_(String(password || ""), salt) !== hash) {
    cache.put("admin_fails", String(fails + 1), LOGIN_LOCK_SECONDS);
    throw new Error("Wrong password.");
  }
  cache.remove("admin_fails");
  const token = Utilities.getUuid();
  cache.put("admin_" + token, "1", ADMIN_SESSION_SECONDS);
  return token;
}

function requireAdmin_(token) {
  if (!token || !CacheService.getScriptCache().get("admin_" + token)) {
    throw new Error("Your session has expired. Log in again.");
  }
}

/* ------------------------------------------------------------------ */
/* Admin actions (called from admin.html via google.script.run)        */
/* ------------------------------------------------------------------ */

/** Full menu for the admin tables (includes hidden items). */
function adminListMenu(token) {
  requireAdmin_(token);
  return readMenu_();
}

/**
 * Adds or updates a drink. Adding writes a full row to the Drinks tab, with created_at.
 * data: { id?, name, group, photo_url, sheet_label, active, sort }
 */
function adminSaveDrink(token, data) {
  requireAdmin_(token);
  const name = String(data.name || "").trim();
  const group = String(data.group || "").trim();
  const sheetLabel = String(data.sheet_label || "").trim();
  if (!name) throw new Error("Name is required.");
  if (!group) throw new Error("Group is required.");
  if (!sheetLabel) throw new Error("Sheet label is required.");
  return saveRow_(DRINKS_SHEET, data.id, function (id, isNew) {
    return { id: id, name: name, group: group, photo_url: String(data.photo_url || "").trim(),
             sheet_label: sheetLabel, active: data.active !== false, sort: Number(data.sort) || 0 };
  }, "drink");
}

/** Adds or updates a milk. data: { id?, label, sheet_label, active, sort } */
function adminSaveMilk(token, data) {
  requireAdmin_(token);
  const label = String(data.label || "").trim();
  const sheetLabel = String(data.sheet_label || "").trim();
  if (!label) throw new Error("Label is required.");
  if (!sheetLabel) throw new Error("Sheet label is required.");
  return saveRow_(MILKS_SHEET, data.id, function (id, isNew) {
    return { id: id, label: label, sheet_label: sheetLabel, active: data.active !== false, sort: Number(data.sort) || 0 };
  }, "milk");
}

/**
 * Adds or updates an option, such as sweetness: half sugar. Options apply to every drink.
 * data: { id?, group, label, sheet_label, active, sort }
 * Any group name works, so new groups need no code change. Typing an existing group name adds to it.
 */
function adminSaveOption(token, data) {
  requireAdmin_(token);
  const group = String(data.group || "").trim();
  const label = String(data.label || "").trim();
  const sheetLabel = String(data.sheet_label || "").trim();
  if (!group) throw new Error("Group is required.");
  if (!label) throw new Error("Label is required.");
  if (!sheetLabel) throw new Error("Sheet label is required.");
  return saveRow_(OPTIONS_SHEET, data.id, function (id, isNew) {
    return { id: id, group: group, label: label, sheet_label: sheetLabel, active: data.active !== false, sort: Number(data.sort) || 0 };
  }, "option");
}

/** Shows or hides an item without deleting it, so old orders still make sense. */
function adminSetActive(token, sheetName, id, active) {
  requireAdmin_(token);
  if ([DRINKS_SHEET, MILKS_SHEET, OPTIONS_SHEET].indexOf(sheetName) < 0) throw new Error("Unknown menu tab.");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(sheetName);
    const row = findRowById_(sheet, id);
    if (!row) throw new Error("Item not found.");
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    sheet.getRange(row, headers.indexOf("active") + 1).setValue(!!active);
    sheet.getRange(row, headers.indexOf("updated_at") + 1).setValue(new Date());
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove("menu");
  syncOrderDropdowns_();
  return { status: "success" };
}

/**
 * Writes one item to a menu tab under the script lock.
 * build(id, isNew) returns the fields for the row. New items get a generated id.
 */
function saveRow_(sheetName, existingId, build, kind) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let id;
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error('Tab "' + sheetName + '" not found. Run setupMenuTabs_() from the editor.');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);

    const isNew = !existingId;
    id = isNew ? newId_(kind, sheet) : String(existingId);
    const row = findRowById_(sheet, id);
    if (!isNew && !row) throw new Error("Item not found.");

    const now = new Date();
    const fields = build(id, isNew);
    fields.updated_at = now;
    if (isNew) fields.created_at = now;
    else fields.created_at = sheet.getRange(row, headers.indexOf("created_at") + 1).getValue();

    const values = headers.map(function (h) { return fields[h] !== undefined ? fields[h] : ""; });
    const target = isNew ? sheet.getLastRow() + 1 : row;
    sheet.getRange(target, 1, 1, headers.length).setValues([values]);
    if (headers.indexOf("active") >= 0) {
      sheet.getRange(target, headers.indexOf("active") + 1).setValue(!!fields.active);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove("menu");
  try {
    syncOrderDropdowns_();
  } catch (err) {
    // The row is already saved; a failed dropdown refresh shouldn't look like a failed add.
    console.error("Dropdown sync failed: " + err);
  }
  return { status: "success", id: id };
}

function findRowById_(sheet, id) {
  if (!sheet) return 0;
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

/** Readable, unique id like "iced-matcha-x7k2". */
function newId_(kind, sheet) {
  let id;
  do {
    id = kind + "-" + Utilities.getUuid().slice(0, 6);
  } while (findRowById_(sheet, id));
  return id;
}

/**
 * Keeps the drink and milk dropdowns on every orders tab (Sheet1 and each day's tab)
 * in step with the active menu. Existing order rows keep their values; only new entries
 * are checked against the list.
 */
function syncOrderDropdowns_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const menu = readMenu_();
  ss.getSheets().forEach(function (sheet) {
    if (sheet.getName() === ORDERS_SHEET || DAY_TAB_PATTERN.test(sheet.getName())) {
      setOrderDropdowns_(sheet, menu);
    }
  });
}

function setOrderDropdowns_(sheet, menu) {
  const drinkLabels = menu.drinks.filter(function (d) { return d.active; }).map(function (d) { return d.sheet_label; });
  const milkLabels = menu.milks.filter(function (m) { return m.active; }).map(function (m) { return m.sheet_label; });

  const rows = Math.max(sheet.getMaxRows() - FIRST_DATA_ROW + 1, 1);
  // With nothing active, clear the dropdown so hidden labels can't be picked.
  setLabelDropdown_(sheet.getRange(FIRST_DATA_ROW, COL_DRINK_DROPDOWN, rows, 1), drinkLabels);
  setLabelDropdown_(sheet.getRange(FIRST_DATA_ROW, COL_MILK_DROPDOWN, rows, 1), milkLabels);
}

function setLabelDropdown_(range, labels) {
  if (labels.length === 0) {
    range.clearDataValidations();
    return;
  }
  range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(labels, true).build());
}

/* ------------------------------------------------------------------ */
/* One-time setup (run from the editor)                                */
/* ------------------------------------------------------------------ */

/**
 * Run once from the editor. Creates the Drinks, Milks and Options tabs in the orders spreadsheet,
 * seeds Drinks and Milks with the current menu, and sets the order dropdowns. Safe to re-run:
 * it only creates tabs that are missing and only seeds empty tabs.
 */
function setupMenuTabs_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const drinkHeaders = ["id", "name", "group", "photo_url", "sheet_label", "active", "sort", "created_at", "updated_at"];
  const milkHeaders = ["id", "label", "sheet_label", "active", "sort", "created_at", "updated_at"];
  const optionHeaders = ["id", "group", "label", "sheet_label", "active", "sort", "created_at", "updated_at"];

  const drinks = ensureTab_(ss, DRINKS_SHEET, drinkHeaders);
  if (drinks.getLastRow() < 2) {
    const now = new Date();
    const seed = [
      ["iced-matcha", "iced matcha latte", "matcha", "assets/iced-matcha-latte.png", "matcha", true, 10, now, now],
      ["strawberry-matcha", "strawberry matcha latte", "matcha", "assets/strawberry-matcha-latte.png", "stw mtch", true, 20, now, now],
      ["iced-hojicha", "iced hojicha latte", "hojicha", "assets/iced-hojicha-latte.png", "hojicha", true, 30, now, now],
      ["strawberry-hojicha", "strawberry hojicha latte", "hojicha", "assets/strawberry-hojicha-latte.png", "stw hoji", true, 40, now, now]
    ];
    drinks.getRange(2, 1, seed.length, drinkHeaders.length).setValues(seed);
  }

  const milks = ensureTab_(ss, MILKS_SHEET, milkHeaders);
  if (milks.getLastRow() < 2) {
    const now = new Date();
    milks.getRange(2, 1, 2, milkHeaders.length).setValues([
      ["whole", "whole", "whole", true, 10, now, now],
      ["oat", "oat", "oat", true, 20, now, now]
    ]);
  }

  ensureTab_(ss, OPTIONS_SHEET, optionHeaders); // starts empty; add options in the admin page

  CacheService.getScriptCache().remove("menu");
  syncOrderDropdowns_();
  Logger.log("Menu tabs ready.");
}

/**
 * Run this one from the editor's function dropdown. Apps Script hides functions whose names
 * end in "_", so setupMenuTabs_ doesn't appear there. This wrapper only creates missing tabs.
 */
function runSetupMenuTabs() {
  setupMenuTabs_();
}

function ensureTab_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  return sheet;
}
