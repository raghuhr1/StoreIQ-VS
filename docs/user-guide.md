# User guide

For store operations staff, inventory managers and administrators.

Keep scanning exactly as today: on the Zebra RFD40 app, select the zone, scan, and export. Then use this portal to clean the results.

## Roles

| Role     | Can do                                                         |
| -------- | -------------------------------------------------------------- |
| Viewer   | See dashboards, jobs and results                               |
| Operator | Also upload scans, run processing and download files           |
| Manager  | Also configure stores, zones, anchor tags and calibration data |
| Admin    | Also manage users, processing profiles and audit logs          |

You only see the menu sections your role allows.

## First-time setup (Manager or Admin)

1. Sign in with the temporary password you were given and choose a new one (at least 12 characters).
2. Open **Store Configuration → Add a store**. Enter name, code and the store's time zone. Sales Floor and Back Room zones are created automatically.
3. Open the store to add zones (Receiving, Fitting Room, …) or **aliases**, which are the names your exports use for a zone (for example `SF`, `Floor`).
4. Optional: in **Anchor Tags**, register fixed tags installed in known zones.
5. Admin: in **Users and Access**, add colleagues with the right role. Each new user's temporary password is shown once; share it securely.

## Everyday use (Operator)

### 1. Upload scans

**Upload Scans** → select the store → **Continue**.

- **Separate files (default):** choose the Sales Floor export as File 1 and the Back Room export as File 2.
- **One combined file:** click _Use one combined file instead_ when one export contains a zone column.
- Optional: give each file a session label (for example `SF 27 Oct evening`).

Click **Upload and preview**. Only CSV files are accepted; save Excel files as CSV (UTF-8) first. A warning appears if you upload the same file twice. Never process duplicates together.

### 2. Map columns

The system suggests which column is the EPC, zone, RSSI, timestamp, and so on. Check the suggestions against the sample rows. Only **EPC** is required, plus **Zone** for combined files. Unused columns can be left as "ignore". If dates look like `03/04/2026`, choose the date format (day/month or month/day). Save the mapping under a name so it is applied automatically to future exports of the same format.

### 3. Validate

**Validate all rows** shows total, valid and invalid rows, unique EPCs, and the problems found, with row numbers. For combined files, check the _Zone values_ table: map any value marked "Unknown" to a zone, then **Re-validate**. Continue when every file shows _Ready to process_.

### 4. Process

Keep the default processing profile unless your administrator says otherwise, then **Start processing**. The job page shows progress and refreshes by itself.

### 5. Review results

On the completed job page:

- **Raw observed vs cleaned inventory:** how many EPCs each zone had before and after cleaning.
- **Cleaned inventory:** EPCs assigned to each zone.
- **Exceptions:** EPCs that **need review** (recommended action shown on each row), and EPCs **excluded** from a zone as cross-reads (for example, a Back Room item read through the wall during the Sales Floor scan).
- **Observed inventory:** everything that was read, per zone.
- **Rejected rows:** rows that could not be used, with the reason.

Click an EPC to see why it was classified that way and which source rows it came from.

How to read the results:

- _Accepted_ means the evidence places the item in that zone.
- _Needs review_ means the system could not decide safely. Check these items physically.
- _Rejected from zone_ means excluded from that zone's count only. It never means the item is missing from the store.
- The evidence score (0–100) is a guide, not a probability. "Rule only" means the export had no signal data to score.

### 6. Download

Under **Download outputs**: `cleaned_sales_floor.csv`, `cleaned_back_room.csv`, `exceptions.csv`, `observed_inventory.csv` and `processing_summary.csv`. **Cleaned Inventory** and **Exceptions** in the menu always show the latest completed job, and let you pick older ones.

If a job **fails**, the page explains why. Mapping problems: fix the mapping and upload again. Temporary system errors: click **Retry job**.

## Checking accuracy (Manager)

Accuracy is only shown once you provide physically checked labels.

1. After a scan, physically confirm the true zone of a sample of items, especially those near doorways and shared walls.
2. Prepare a CSV with columns `epc,actual_zone` (optionally `category,notes`).
3. **Reports → Calibration and ground-truth datasets**: upload it as **Ground truth** and link it to the job.
4. Pick the job in Reports and click **Evaluate job**. You get recall, false acceptance, and a raw vs cleaned comparison per zone.

Use a separate **Calibration** dataset, from a different day, to get threshold suggestions. An administrator applies them as a new profile version in **Settings**. Details: [calibration-and-accuracy.md](calibration-and-accuracy.md).

## Admin tasks

- **Settings → Processing profiles:** change thresholds; every save creates a new version and never alters past jobs.
- **Audit Logs:** who uploaded, processed, changed or downloaded what.
- **Users and Access:** change roles, disable or remove users. The last administrator cannot be removed.
