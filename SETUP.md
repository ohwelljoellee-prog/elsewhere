# Elsewhere POS — Setup

Two pieces: `index.html` (the order-taking page) and `apps-script.gs` (the backend that logs each order as a row in your Google Sheet).

## 1. Connect the spreadsheet

1. Open your sheet: https://docs.google.com/spreadsheets/d/1D9x6xpV8-jjTUdHYVQf44TSXxGDXl-yl82jTIpNJqxA/edit
2. Extensions → Apps Script.
3. Delete anything in the editor and paste in the contents of `apps-script.gs`.
4. Save the project (any name).
5. Deploy → New deployment → type: **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click Deploy, authorize when prompted, then copy the **Web app URL** it gives you (ends in `/exec`).

## 2. Point the page at your backend

1. Open `index.html` in a text editor.
2. Find this line near the top of the `<script>` block:
   ```js
   const APPS_SCRIPT_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";
   ```
3. Replace it with the URL you copied, e.g.:
   ```js
   const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycb.../exec";
   ```
4. Save.

## 3. Run it

- Locally: just open `index.html` in a browser (double-click it).
- On a tablet/register at the counter: host the file somewhere reachable (e.g. GitHub Pages, Netlify drop, or a simple local web server) and open that URL on the device.

Every submitted order writes one row per drink into the "Sheet1" tab (headers on row 2, data starting row 3): a checkbox (A), order # (B), name (C), drink (D), milk selection (E), time (F), phone (G). Rows in the same order share the same order number, name, and phone, and the script reuses any blank rows in the table before adding new ones at the bottom.

The order number shown to the customer on the confirmation screen **is** column B — the page reads the real number back from the Apps Script response after a successful sync, so there's exactly one number, not a local guess and a separate sheet number. It's assigned by the script itself — one more than the highest number already in the column (starting at 1 on an empty sheet, or continuing on from whatever's already there) — lock-protected so two devices submitting at the same moment can't collide.

## Reliability: orders are never silently lost

If the page can't reach the Apps Script (bad wifi, script paused, etc.), the order is **not** discarded:

- It's saved in the browser's local storage on that device, and the confirmation screen shows a **provisional** local number with a note that it'll sync automatically — this provisional number is only a placeholder for the offline case and won't match column B; check the sheet once it's synced for the real number.
- A small badge in the bottom-right corner shows how many orders haven't synced yet.
- The page retries automatically every 30 seconds, whenever the device comes back online, and on page load — as soon as the Apps Script is reachable again, queued orders get appended to the sheet in the order they were taken. Only one sync cycle runs at a time, so a slow sync won't cause the same order to be sent twice.

This means if you deploy the backend later, or it goes down temporarily, staff can keep taking orders on the same device and nothing gets lost — just don't clear the browser's site data before it's had a chance to sync.

Note: the provisional-number counter (used only while offline) lives in each browser's local storage, same as the pending-orders queue — it doesn't sync across devices. Once synced, every order's real, customer-facing number is the one the spreadsheet assigned, so it's never duplicated.

## Testing before you rely on it

1. Deploy the Apps Script and paste the URL into `index.html` as above.
2. Open the page, place a test order, and confirm a new row appears in the sheet within a second or two.
3. To test the offline path: turn off wifi, place an order (you should see "saved on this device" + the sync badge), then turn wifi back on and watch the badge disappear as it syncs — check the sheet for the row.

## Notes

- If you ever redeploy the Apps Script (not just edit-and-save, but a new deployment), you'll get a new URL and need to update `index.html` again. Editing the script and clicking "Deploy → Manage deployments → edit → Deploy" on the *same* deployment keeps the same URL.
- The page has no login/auth — anyone with the link can submit orders. Fine for an in-person counter iPad; don't publish the link publicly.
- The pending-orders queue lives in that browser's local storage — it does not sync across devices/browsers. If you run the POS from multiple devices, each has its own local retry queue.
