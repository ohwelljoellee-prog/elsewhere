# Elsewhere POS — Setup

Three pieces:

- `index.html` — the order-taking page (the POS). Reads the menu from the sheet.
- `apps-script.gs` — the backend, attached to your existing "elsewhere orders" spreadsheet. Logs orders, serves the menu, and handles admin changes.
- `admin.html` — the password-protected admin page, served by the same Apps Script project.

Everything lives in the existing spreadsheet: `Sheet1` (orders), `Drinks`, and `Milks`.

## 1. Install the backend in the spreadsheet

1. Open your sheet: https://docs.google.com/spreadsheets/d/1D9x6xpV8-jjTUdHYVQf44TSXxGDXl-yl82jTIpNJqxA/edit
2. Extensions → Apps Script.
3. Replace the contents of `Code.gs` with the contents of `apps-script.gs`.
4. Add the admin page: click **+** next to Files → **HTML**, name it exactly `admin` (so the file is `admin.html`), and paste in the contents of `admin.html`.
5. Save.

## 2. Create the menu tabs

1. In the Apps Script editor, pick `setupMenuTabs_` from the function dropdown and click **Run**. Authorize when asked.
2. Go back to the spreadsheet. You should now have `Drinks` and `Milks` tabs seeded with the current four drinks and two milks.
3. The order sheet's drink and milk dropdowns are reset to match the menu.

Run `setupMenuTabs_` again any time; it only fills tabs that are empty.

## 3. Set the admin password

1. In the Apps Script editor, go to **Project Settings → Script Properties** and add `NEW_ADMIN_PASSWORD` with your chosen password. The password isn't stored in the code, because this repo is public.
2. Run `setAdminPassword_` once. It's hidden from the editor's dropdown, so temporarily rename it to `setAdminPassword` (no underscore), run it, then rename it back. A public name would let anyone who opens the admin page reset the password.
3. Delete the `NEW_ADMIN_PASSWORD` property.
2. To use a different password, edit the string in `setAdminPassword_`, run it, then change the string back. Only a salted hash is stored in the project's Script Properties.

`setAdminPassword_` and `setupMenuTabs_` have trailing underscores, so the admin page can't call them. If they don't appear in the editor's function dropdown, tell me and I'll add another way to run them. Logging in fails for 15 minutes after five wrong attempts.

## 4. Deploy the web app

1. Deploy → **Manage deployments** → edit the existing deployment → **New version** → **Deploy**.
   - Use the existing deployment (not New deployment) so the URL stays the same and the iPad keeps working.
   - Execute as: **Me**. Who has access: **Anyone**.
2. Copy the Web app URL (ends in `/exec`). If this is the first deployment, copy it from the Deploy dialog.

## 5. Point the POS page at the backend

1. Open `index.html` and check that `APPS_SCRIPT_URL` is the Web app URL from step 4.
2. Host the page as before (double-click for testing, or a static host for the counter device).

## 6. Use the admin page

- Admin: `<your Web app URL>?page=admin`. Bookmark it on the admin device.
- Log in with the password from step 3.
- **Drinks** and **Milks** tabs list every item. Use **+ Add drink** or **+ Add milk** to open the popup form.
- Each drink has: name, group (its section heading on the POS, such as `matcha`), photo link (optional), and sheet label (the value written into the order sheet, such as `matcha`).
- **Hide** removes an item from the POS without deleting it, so past orders still make sense. **Show** brings it back.
- Changes show on the POS within about 30 seconds.

Every item you add is written as a full row to its tab, with `created_at` and `updated_at` timestamps.

## How orders are logged

Each drink in an order becomes one row on `Sheet1`: a checkbox (A), order # (B), name (C), drink (D), milk (E), time (F), and phone (G, left blank). Rows in the same order share the order number and name. The order number shown on the confirmation screen is the number in column B, assigned by the script. It's one more than the highest number already in the column, and the script lock keeps two devices from taking the same number.

## Reliability: orders are never silently lost

If the page can't reach the Apps Script (bad wifi, script paused, etc.), the order is **not** discarded:

- It's saved in the browser's local storage on that device, and the confirmation screen shows a **provisional** local number with a note that it'll sync automatically. That number is only a placeholder for the offline case and won't match column B.
- A small badge in the bottom-right corner shows how many orders haven't synced yet.
- The page retries every 30 seconds, whenever the device comes back online, and on page load, and sends queued orders in the order they were taken.

The page also keeps the last good menu on the device, so it can still show the menu when offline. Don't clear the browser's site data before a queued order has synced.

## Testing before you rely on it

1. Place a test order and confirm a new row appears in `Sheet1` within a second or two.
2. Add a test drink in the admin page. Confirm it appears on the POS within about 30 seconds, and that its sheet label shows in the drink dropdown on `Sheet1`.
3. Hide that drink. Confirm it disappears from the POS, and that old orders for it remain.
4. Test the offline path: turn off wifi, place an order (you should see "saved on this device" and the sync badge), turn wifi back on, and confirm the row appears.
5. Try the admin password with a wrong value. Confirm it's refused.

## Notes

- Any change to the backend needs a new version of the **same** deployment (step 4), so the URL doesn't change.
- Admin actions run as you, the script owner. The password check runs before every admin action. The public part of the deployment only serves the menu and accepts orders.
- The POS has no login, so anyone with the POS link can submit orders. Use it on the counter device and don't publish the link.
- The queue and menu cache live in each browser's local storage and don't sync across devices.
