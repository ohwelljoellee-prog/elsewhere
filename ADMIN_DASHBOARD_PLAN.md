# Elsewhere POS — Admin Dashboard Plan

Goal: stop hard-coding the drinks and milk options. The menu lives in a spreadsheet. An admin page lets you change options, add new ones through a popup form, and every change is written to that spreadsheet. The POS page and the order backend read the menu from it instead of from code.

## Where things are today (hard-coded in 3 places)

| What | Where | Problem |
|---|---|---|
| Drink list, photos, section grouping | `index.html` → `const MENU` (~line 438) | Changing a drink means editing code and redeploying the page |
| Milk options (`whole`, `oat`) | `index.html` (milk pills, ~line 553) and `apps-script.gs` → `MILKS` | Same, and in two places |
| Drink name → sheet value (`matcha`, `stw mtch`…) | `apps-script.gs` → `DRINKS` | Adding a drink means editing the script and updating the orders-sheet dropdown by hand |

## Target design

```
 Admin page (popup forms)            POS page (index.html)
          │  add / edit / hide            ▲  GET ?action=menu
          ▼                               │  (cached on the device)
 ┌─────────────────────────────────────────────────────────┐
 │ Apps Script web app  (one project, two deployments)     │
 │   • admin deployment  → Google sign-in + email allowlist│
 │   • POS deployment    → anonymous (as today)            │
 └─────────────────────────────────────────────────────────┘
          │ reads / writes                 │ appends orders
          ▼                                ▼
 "Elsewhere Menu" spreadsheet (NEW)    "elsewhere orders" spreadsheet (existing)
   tabs: Drinks, Milks                    Sheet1 (Purchase_orders table)
```

### Decisions (updated after your answers)

1. **Menu lives in the existing orders spreadsheet**, as new `Drinks` and `Milks` tabs. (I first suggested a separate spreadsheet; you said to use the existing one.)
2. **Admin lives in the same Apps Script project**, served from the same deployment at `?page=admin`. The POS URL doesn't change.
3. **Admin access = a password**, checked on the server. Only a salted hash is stored. Sessions last 6 hours. Five wrong attempts lock logins for 15 minutes.
4. **Adding an item writes a full row** to its tab, with all its details and timestamps. Orders still write one row per drink.
5. **No prices.**
6. **Options are never deleted, only hidden** (`active = FALSE`). Old orders reference the sheet label, and deleting a drink would break history.
7. **Orders reference stable IDs** (`iced-matcha`, `oat`), not display names, so renaming a drink doesn't break anything. Old queued orders with names still sync.

**Status:** built: `apps-script.gs`, `admin.html`, `index.html`. Setup and testing steps are in `SETUP.md`. Not yet deployed or tested against the live sheet.

## Data model

**Drinks tab** (one row per drink)

| Column | Example | Notes |
|---|---|---|
| `id` | `iced-matcha` | Stable key. Generated once, never edited |
| `name` | iced matcha latte | Shown on the POS and sent in old-style orders |
| `group` | matcha | Section heading on the POS. Any text is allowed |
| `photo_url` | Drive or hosted image URL | Falls back to a placeholder if blank |
| `sheet_label` | `matcha` | Value written to the orders sheet dropdown (column D) |
| `active` | TRUE | FALSE hides it from the POS |
| `sort` | 10 | Display order |

**Milks tab**

| Column | Example |
|---|---|
| `id` | `oat` |
| `label` | oat |
| `sheet_label` | `oat` |
| `active` | TRUE |
| `sort` | 20 |

Seed both tabs with the current four drinks and two milks so nothing changes on day one.

## Steps

### Phase 1 — Menu spreadsheet (no code yet)
1. Create a new spreadsheet, "Elsewhere Menu", with tabs `Drinks` and `Milks` and the columns above.
2. Enter the current four drinks and two milks. Copy the four photos into a Drive folder and paste their links.
3. Record the spreadsheet ID in Script Properties (`MENU_SHEET_ID`), not in the code.

### Phase 2 — Backend (`apps-script.gs`)
4. Remove the `DRINKS` and `MILKS` constants. Add `getMenu_()`, which reads active rows from both tabs, sorted by `sort`.
5. Add `doGet(e)`: when `action=menu`, return the menu as JSON. Cache it in `CacheService` for about 60 seconds so every iPad poll doesn't hit the sheet.
6. Change `submitOrder` to look up each item by `id` in `getMenu_()` and write the drink's `sheet_label` and the milk's `sheet_label`. Reject inactive or unknown IDs.
7. **Backwards compatibility:** the POS already has orders queued in browser storage with display names in them. Keep accepting `drink` names as a fallback (match on `name`) so those queued orders still sync.
8. Keep the duplicate guard, but build its fingerprint from IDs.
9. Add admin actions, all behind the allowlist check (`Session.getActiveUser().getEmail()`) and `LockService`: `listMenu`, `saveDrink` (create or update), `saveMilk`, `setActive`, `reorder`.
10. Add `syncDropdowns_()`: after any save, rewrite the data-validation lists on the orders sheet (columns D and E) from the active `sheet_label` values. Without this, new drinks can't be picked in the orders sheet.

### Phase 3 — Admin dashboard (new HTML file served by the admin deployment)
11. Create `admin.html` with two tables (Drinks, Milks). Each row shows name, group, photo thumbnail, active toggle, and sort. Include an "edit" action.
12. Build the popup forms (HTML `<dialog>`):
    - **Add drink**: name, group (pick existing or type new), photo, sheet label, active. Generates the `id`.
    - **Add milk**: label, sheet label.
    - **Edit**: same fields, with `id` and `sheet_label` read-only once any order uses them.
13. Save with `google.script.run`, reload the table, and show errors inline.
14. Add a "Sync orders dropdowns" button as a fallback, in case the automatic sync failed.
15. Deploy as a **second web app**: Execute as Me, access "Anyone with Google account". Keep this URL private and bookmark it. The POS deployment stays "Anyone".

### Phase 4 — POS page (`index.html`)
16. Delete the `MENU` constant and the hard-coded `whole`/`oat` pills.
17. On load, fetch `APPS_SCRIPT_URL?action=menu`. Cache the result in `localStorage` and render from the cache when offline.
18. Keep a small built-in fallback menu for the very first load with no network. It should match the seed data.
19. Render section headings from each drink's `group`, and milk pills from the Milks tab.
20. Send `drinkId` and `milkId` in the payload. Keep the existing `name`/`milk` fields for the queued-order fallback.
21. Refresh the menu on each `flushQueue` cycle, so new drinks show up without reloading the iPad.

### Phase 5 — Testing (in this order)
22. Add a test drink in the admin popup. Confirm it shows on the POS within about a minute, and that its dropdown value appears in the orders sheet.
23. Hide a drink. Confirm it disappears from the POS, and that existing orders for it remain in the sheet.
24. Simulate an offline order (see SETUP.md), then sync it. Confirm the old name-based payload still writes correctly.
25. Sign in to the admin page with an email not on the allowlist. Confirm access is refused and no writes happen.
26. Confirm two simultaneous saves don't corrupt the menu (the lock works).

### Phase 6 — Rollout
27. Deploy the backend as a new version of the **existing** POS deployment (Manage deployments → edit → Deploy), so the POS URL in `index.html` stays the same.
28. Deploy the admin page as a new deployment. Save its URL somewhere the admin can find.
29. Update SETUP.md with the admin URL, how to add an admin email, and how to add a drink.

## Things to decide before building

- **Admin emails:** who gets access? (Each one goes in Script Properties.)
- **Photos:** upload from the admin popup (saved to Drive), or paste a link? The plan assumes a link to start, with upload as a later add-on.
- **Prices:** none are tracked today. Adding a `price` column is easy now and would be a bigger change later, so decide before Phase 1.
- **Group names:** should groups be free text, or a fixed list (matcha, hojicha, …)?

## Risks

- **Apps Script runs as you.** Any admin action must check the allowlist first. The POS deployment must never expose admin actions.
- **Dropdown drift.** If the orders sheet dropdowns don't match the menu, the sheet shows errors. Step 10 exists to prevent that.
- **Quota.** Apps Script has daily quotas. The 60-second menu cache keeps POS traffic low.
- **Deployment URLs.** Creating a new deployment (rather than a new version) changes the URL and breaks every iPad. Always use "Manage deployments → edit" on the POS deployment.
