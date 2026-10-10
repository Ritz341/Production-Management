# Floor Sheet Maker (`docs/sheet-maker.html`)

A one-file web page the office uses to print each department's daily **lead sheet** (paper floor sheet) and the **loading sheet** from the week's build sheet. It runs in any browser, needs no login and no server, and works offline apart from opening Excel files and the Excel backup.

It is separate from the main build tracker app (`src/`). It shares that app's rules for reading the build sheet, but it doesn't talk to Supabase. Everything it remembers is stored in that PC's browser.

---

## Using it (the office's morning)

1. **Today's orders.** In the build sheet (the Truesdale tab), select this week's rows, press Ctrl+C, then Ctrl+V into the box. The rows are read straight away. Pasting anywhere on the page outside another field also works.
   - Another way: *Other way: open the Excel file*. Drag in the workbook or click to choose it. Only the **Truesdale** tab is read. This needs internet, because the Excel reader loads from cdn.sheetjs.com.
   - Screenshots aren't read; the rows must come in as text.
2. **The day.** Enter the date, the ship/pickup date, the crew (optional), and a note for the floor, which is printed on every sheet. Lead names are saved on this PC and locked; use *Change* to edit one. Under *Copies to print*, set 0–9 per department (0 leaves that sheet out). *Check-in times & stations* holds the PC's own time blocks, stations and cutting jobs.
3. **Check the list.** The orders appear in build order with one tick per department.
   - *✓ Tick all*, *Untick all*, and each column's *all · none* links set the ticks in bulk.
   - The ▲ ▼ ✕ buttons move or remove an order, and *+ Add order* adds one by hand.
   - Rows highlighted yellow were hard to read; check them against the sheet.
4. **Preview → Print.** The preview shows exactly what prints. *🖨 Print sheets* prints every department's sheet with its copies. *🚚 Print loading sheet* prints the loading sheet. Ctrl+P works too.

Today's list survives a refresh or a closed tab until midnight.

---

## How the build sheet is read

The reading rules match the main app's importer (`src/lib/parseSheet.js`), so both read a sheet the same way.

- **Header row:** a row containing "Tag Name" gives the column names. Columns are matched loosely, ignoring case, spaces and punctuation.
- **No header in the paste** (a selection from the middle of the sheet):
  - The Tag Name column is found by its values. Tags look like `FOSTER_168004`, that is, `_` followed by 4+ digits.
  - The columns to its left are taken as Dealer, Truck and Date.
  - The columns to its right are named in the order the last header was seen on this PC. Failing that, the build sheet's usual order is used: Mods, V4T, Vin. Fix, Vin. Trap, Alum. Fix, Alum. Trap, XX, H2/4, PVC, I-A, Doors, Roof Panels, Roof Extr., Track, Therm a deck, Acrylic, Deck, Valance, Rail, PATIO Door, Glass, Pergola, R. Screen, Nova Sun, Stairs.
  - A message asks you to check the ticks.
- **No columns found at all:** anything shaped like a tag is taken, one per line, and put on every sheet ("loose" mode, with a warning).
- **Pickup banners:** a "PICK UP 10/2" row in the Dealer column starts a pickup section.
  - If the read covers more than one pickup, the page asks which one today's sheets are for and sets the ship date from it.
  - A month/day more than ~6 months in the past is taken to be next year's.
- **Left off:** rows whose Date column says Shipped / Picked up, banner rows, and "Current as of" rows. The message lists how many shipped orders were skipped.
- **Excel quirks:** a cell containing a line break arrives in quotes; the paste is split by walking the text, so one order isn't cut in two.
- **Duplicates:** an order already on the list (same tag, any case) isn't added twice.

### What a cell means on the sheets

Every order goes on every department's sheet as the build sheet lists it, and a C never takes it off. Each job's Start/Done boxes show what its build-sheet cell said:

| Build-sheet cell | On the printed sheet |
|---|---|
| blank | **Hatched** — not part of this order |
| `C` | Light **C** in the boxes — already done (stays on the sheet so the lead sees it) |
| anything else (X, a number…) | Open boxes to fill in |
| column not in the paste / typed-in order | Open boxes |

`# of mods` is filled in on the Mods sheet when the Mods cell is a number.

---

## The departments (`DEPARTMENTS` in the script)

| Sheet | Jobs (build-sheet column it follows → label) | Stations in the daily count | Unit | Notes |
|---|---|---|---|---|
| **Mods** | Mods → Mods | Framing (frames), Staging (finished mods) | mods | Start · **Pause** · Done boxes; extra write-in columns `# of mods` (pre-filled when known) and `# of corner posts` |
| **V4T** | **One row per step under each tag:** V4T vents, V4T frame, V4T squaring, V4T screen (follow V4T); Vinyl fix (Vin. Fix); Vinyl trap (Vin. Trap) | Vents building, Vents glazing, Frames built, Frames squared | inserts | Each step row has its own Start / Done. A step whose column is blank for the order is left out (vinyl rows only show when the order has them); C shows a light C. Steps editable on the PC. Vent cutting is **not** on this sheet (it's TA144's) |
| **Track** | Track | Tracks done | tracks | |
| **Panel** | Roof Panels, Roof Extr., Acrylic, Mod Filler Panels → "Filler" | Roof panels, Mod filler panels, Acrylic panels | panels | **Every order** is on it (every order gets filler); roof items hatched when the room has no roof panel. Each bench counts its own panels |
| **SC220** (CNC) | Mods → Mods frames; V4T → V4T uprights | Mods frames, V4T uprights | pieces | Jobs editable on the PC |
| **TA144** (CNC) | V4T → Vents — cut & drill | Vents cut & drilled | vents | Jobs editable on the PC |
| **Manual cut** | V4T → V4T framing (cut & punch); Vin. Trap → trap cut to length; Vin. Fix → vinyl fix cut to length; Mods → corner posts | V4T framing, Traps, Vinyl fix, Corner posts | pieces | Jobs editable on the PC |

A cutting job "follows" the column of what it feeds. For example, SC220's mod frames follow Mods: an order with no Mods has its frame boxes hatched, and Mods = C shows them as done. The same idea is used by the main app's cut stations (schema_v21, `bt_cut_follows`).

Under *Check-in times & stations* the PC can change:
- The time blocks (default **7:00–9:00, 9:15–12:00, 12:30–2:00, 2:15–4:00**, up to 6).
- Each department's stations (up to 6).
- For SC220, TA144 and Manual cut: the jobs, their build-sheet column, and an optional heading that groups jobs on the same machine.
- For V4T: the steps (one row each under every order) and the column each follows.
- *Back to the defaults* resets all of it.

---

## What a printed lead sheet looks like

One US-letter page per department (7.6 in printable width):

- **Top:** "Sunspace Truesdale · Lead sheet" (plus "CNC" for the machines), the department name, and Date / Lead / Crew today / Pickup / Completed today ___ orders. The floor note, if set, prints as a banner.
- **Today's orders:** # · Tag name · any extra write-in columns · Start / (Pause) / Done boxes per job · Problem code / comments.
  - The first job's headings carry an example time ("e.g. 7:40") so the floor knows to write the clock time.
  - Long tags break only after a dash or before the order number, never mid-word.
- **Fitting on one page:** with more orders than the normal 15 rows, the rows and their text shrink down to 0.18 in each before spilling onto a second page.
  - The V4T sheet counts in step rows instead (0.24 in each, shrinking to 0.18 in). An order's block of steps never splits across pages. About 6–7 orders fit on a page.
  - Each station past four, a machine-heading row, and a floor note each take one order row.
- **Daily count:** a Crew column, the station, and one box per time block. Each box is how many units were finished *in that block*, not a running total. A crew change is written in the box (e.g. `12 · 4→3`).
- **Problem codes:**
  1. Material shortage
  2. Machine down
  3. Rework / wrong cut
  4. Waiting on another dept
  5. Missing info / paperwork
  6. Short-staffed
  7. Order change
  8. Other — write it

  This is the same list, in the same order, as the tablet's "report a problem" picker.
- **Stops that aren't problems:** B break, LB lunch break, EOS end of shift.
- **Bad part from another department:** write **Q**, the department and what's wrong (e.g. *Q · Panel · 2" short*), and bring it to the office.
- Signed ______ at the bottom.

## The loading sheet

Every order on the list is grouped by its **Truck** column ("No truck" if blank). Each order has a number (running through the whole sheet), the tag, an **On truck** tick box and a Note. A truck group moves to the next page rather than splitting, unless it's bigger than a page. Pickup and date are filled in; Orders, Trucks and Loaded by are left for the loader to write.

## Weekly Excel backup

- Every print (button or Ctrl+P) logs that day's list on this PC. The latest print of a day wins, and about two months are kept.
- *⬇ Week backup (Excel)* downloads one workbook for the week:
  - a **Week** tab: each order and, per day, which departments still had it open
  - one tab per day as printed: leads, crew, and each order's state per department (`open`, `C`, `filler`, or blank)
- Offline, it downloads the Week tab as CSV instead.
- A finished week that was printed but never backed up shows a reminder banner until it's downloaded or skipped.

---

## What's stored on the PC (`localStorage`, keys prefixed `fsm:`)

| Key | What |
|---|---|
| `today` | Today's list and ship date (restored on reload the same day) |
| `leads` | Lead name per department |
| `note` | The floor note |
| `copies` | Copies per department |
| `blocks` | Time blocks |
| `stations` | Stations per department |
| `jobs` | Cutting jobs for SC220 / TA144 / Manual cut |
| `layout` | Last header column order seen (for header-less pastes) |
| `log` | Each printed day's list (≈ 2 months) |
| `backedUp` | Weeks already downloaded or skipped |

Clearing the browser's site data resets all of this. A different PC or browser starts fresh.

---

## Editing the page

- Everything is in one file: CSS at the top, then the HTML, then one `<script>`. There's no build step; open the file in a browser to test it.
- To change what a sheet contains, edit `DEPARTMENTS`. To change the codes, edit `BLOCKS` and keep it in step with the app's `BLOCK_CATEGORIES` in `src/lib/catalog.js`. To change the default blocks, edit `CHECKINS`. To change rows per page, edit `ROWS_PER_PAGE`, and `ROW_H` / `MIN_ROW` for the shrink limits.
- `STATUS_COLS` / `SHEET_COLUMNS` / `DEFAULT_LAYOUT` must match the build sheet's columns. Add a new build-sheet column to all three.
- Print layout is in inches (`@page` letter, `.sheet` 8.5 × 11 in). After a layout change, check the preview with the most orders you expect, and the 6-station / 6-block case.

## History (decisions made with the floor)

- The office asked for these:
  - Hatched = not in this order; C = already done (instead of dropping C orders off the sheet).
  - The CNC and manual-cut sheets ticked for every order by default.
  - *Tick all / Untick all*, plus per-column all · none.
  - Smaller text, so each department fits on **one page**.
- SC220 and TA144 got separate sheets, following the floor's drawing. Vent cutting moved off the V4T sheet to TA144. The V4T stations became Vents building, Vents glazing, Frames built and Frames squared.
- Copies to print per department.
- The text-paste reader was later brought into the main app's Weekly Import, so the app and this page read pastes the same way.
- V4T changed to one row per step under each tag (vents, frame, squaring, screen, plus vinyl fix / trap when the order has them), so each step gets its own Start / Done.
- The page is finished. Change it only for a real floor need, and keep it in step with the app's importer when the build sheet changes.

## Related

- `docs/lead-sheet.html` — a print-ready lead sheet sample.
- `docs/sop.html` — floor SOP.
- Main app importer: `src/lib/parseSheet.js`, `src/pages/AdminImport.jsx`.
