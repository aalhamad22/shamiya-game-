# Shipment ETA Tracker (Google Sheets)

Adds an **ETA audit trail** to the `Shipments-2025` Google Sheet so the team always knows:

- **What we were promised.** The first ETA entered is saved as the *Promised ETA* and locked.
- **What it is now.** *Current ETA* is the date the team updates when the carrier sends news.
- **Who changed it, when, and why.** Every change goes into an append-only *ETA Change Log* tab.
- **How bad it is.** Days late vs. promise, number of ETA changes, and a carrier reliability table.

It runs entirely inside the Google Sheet (Apps Script), so there is no extra tool or login for the team.

---

## 1. Install (one time, ~5 minutes, done by the sheet OWNER)

1. Open the sheet → **Extensions → Apps Script**.
2. Delete any code in `Code.gs` and paste in the full contents of [`Code.gs`](./Code.gs). Click **Save**.
3. **Project Settings (⚙️)** → set the time zone to **(GMT+03:00) Kuwait**.
4. Go back to the sheet and reload the page. A new menu **📦 ETA Tracker** appears.
5. Open the **Bulk Shipments** tab → **📦 ETA Tracker → Set up tracking on this tab**.
   Google will ask for permission the first time. Click *Advanced → Go to project → Allow*.
6. Repeat step 5 for **Sample Shipments** (and any future tab, e.g. `Shipments-2026`).

> ⚠️ The owner must run setup. The edit trigger runs as the person who installed it, and
> that person is the only one allowed to write to the locked columns and the log.

### What setup adds to the tab (new columns on the right)

| Column | Who fills it | Purpose |
|---|---|---|
| **Tracker ID** | automatic | Stable ID (`SHP-0001`) so history survives sorting/renaming |
| **Promised ETA 🔒** | automatic, locked | First ETA ever entered = what we were promised |
| **Current ETA** | **team** | Latest ETA from supplier / carrier (date only) |
| **ETA Change Reason** | **team** | Why it changed. Turns yellow until filled |
| **# ETA Changes** | automatic | How many times the ETA moved |
| **Delay vs Promise (days)** | automatic | Current ETA − Promised ETA (red if > 7) |
| **Last ETA Change By / At** | automatic | Email + time of last change |

It also creates two tabs:

- **ETA Change Log**: one row per change (timestamp, person, shipment, field, old → new,
  days moved, total delay, reason). It is protected so nobody can edit or delete history,
  but anyone can filter it. Status, Shipped by, Tracking No and Remarks edits are logged too.
- **ETA Dashboard**: KPIs, open shipments sorted by delay, carrier reliability, and the
  latest 20 changes. It refreshes every morning at 7:00, or on demand from the menu.

---

## 2. Team rules (share this part with the team)

1. **New shipment:** fill the row as usual and enter the supplier's / carrier's ETA in
   **Current ETA**. It is automatically copied to **Promised ETA 🔒**.
2. **Carrier changes the date:** overwrite **Current ETA** with the new date. Do **not**
   write ETAs in "Remarks" anymore.
3. **Then type the reason** in the yellow **ETA Change Reason** cell
   (e.g. *"Vessel rolled over at Jebel Ali"*, *"Customs inspection"*, *"Supplier late in production"*).
4. **Want the full story of a shipment?** Click any cell in its row →
   **📦 ETA Tracker → Show ETA history of selected shipment**.
5. **The promise itself really changed** (e.g. re-negotiated order): only the owner can use
   **Re-baseline promised ETA**. It asks for a reason and is logged as `RE-BASELINED`.

---

## Notes and limits

- **Who changed it:** Google gives the editor's email for people in the same Google Workspace
  (e.g. `@shopflain.com`). Editors outside the company domain show as
  *"Unknown (outside company domain)"*. For those, the sheet's own *File → Version history*
  is the backup.
- **Old rows:** shipments already marked *Received* have no ETA, so they are not tracked.
  Tracking starts from the first time an ETA is entered.
- **Bulk paste** into *Current ETA* is supported. Each row is logged separately.
- **Settings** such as statuses that count as "done", watched columns and date format live in the
  `CONFIG` block at the top of `Code.gs`.
