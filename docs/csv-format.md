# CSV input and output formats

## Input (scan exports)

The exact Zebra RFD40 export format has not been confirmed, so input is mapped per file. Nothing beyond an EPC and a zone is assumed to exist.

**Accepted files:** `.csv` or `.txt`; UTF-8 with or without BOM; delimiter `,` `;` tab or `|` (auto-detected from the header); CRLF, LF or CR line endings; RFC 4180 quoting (embedded commas, quotes, line breaks). Rejected: XLSX/ZIP, binary content, non-UTF-8 text, empty files, files over `MAX_UPLOAD_BYTES` (default 200 MB), jobs over `MAX_ROWS_PER_JOB` (default 1,000,000 rows).

**Patterns:**

- **A — separate zone files:** each file is assigned to a zone at upload (e.g. Sales Floor file, Back Room file). Session = the upload's session label unless a session column is mapped.
- **B — combined file:** a zone column is mapped. Session = the session column, or `<label>:<zone code>` when absent.

**Canonical fields and recognised header aliases** (case, spacing and punctuation insensitive; full list in `src/engine/mapping.ts`):

| Field                | Required              | Example aliases                               |
| -------------------- | --------------------- | --------------------------------------------- |
| EPC                  | yes                   | EPC, Tag ID, TagID, RFID Tag ID, EPC Hex, UII |
| Zone                 | combined files        | Zone, Location, Area, Zone Code               |
| Scan session         | no                    | Session ID, Scan ID, Inventory ID, Batch ID   |
| Timestamp            | no                    | Timestamp, Date Time, Read Time, Last Seen    |
| RSSI                 | no                    | RSSI, Peak RSSI, Signal Strength              |
| Read count           | no                    | Read Count, Reads, Seen Count, Times Seen     |
| Phase                | no (recorded, unused) | Phase, Phase Angle                            |
| Reader ID            | no                    | Reader ID, Device ID, Serial Number           |
| Antenna ID           | no                    | Antenna, Antenna Port                         |
| Channel              | no                    | Channel, Frequency                            |
| Transmit power       | no                    | Tx Power, Power Level                         |
| Anchor-tag indicator | no                    | Anchor, Is Anchor, Reference Tag              |

Unmapped columns are ignored. Decimal commas (`-50,5`) are accepted. Timestamp formats: ISO 8601, epoch seconds/milliseconds, and `D/M/YYYY` or `M/D/YYYY` (only when unambiguous, unless the format is chosen in the mapping). Offset-less times use the store's IANA time zone.

Row numbers in messages are record numbers with the header as row 1; they equal line numbers unless a field contains a line break.

### Label files (calibration and ground truth)

Columns: `epc`, `actual_zone` (zone code or name), optional `category` (`KNOWN_LOCATION`, `BOUNDARY`, `CROSS_READ_EXAMPLE`, `AMBIGUOUS`), optional `notes`. Maximum 200,000 labels or 20 MB.

## Outputs

Schema version **`svs-export/1.0`**. All files: UTF-8 without BOM, RFC 4180 quoting, CRLF line endings, header row always present (even with zero data rows), stable column order. Timestamps are ISO 8601 UTC with milliseconds (`2026-10-01T09:00:00.000Z`). Missing optional values are empty cells, never invented. Zones are written as zone **codes**. Multi-valued cells use `|`. Files are deterministic for identical inputs and profile (except `created_at`/`completed_at`).

**Formula-injection protection:** any text cell beginning with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with `'`. Numeric cells (e.g. negative RSSI) are written as numbers and are not altered.

### `observed_inventory.csv` — one row per unique EPC per observed zone (anchors excluded)

`job_id, store_id, scan_session_id, epc, observed_zone, raw_read_count, first_seen, last_seen, median_rssi, data_quality_status`

- `scan_session_id`: session IDs in that zone, `|`-separated.
- `raw_read_count`: lower bound when some rows had no read count.
- `data_quality_status`: `OK`, `PARTIAL_EVIDENCE`, `NO_SIGNAL_DATA`, `SPARSE`, `CONFLICTING_ZONE_LABEL`, `MALFORMED_EPC`.

### `cleaned_sales_floor.csv`, `cleaned_back_room.csv` (and `cleaned_zone_<code>.csv` for other zones)

`job_id, store_id, epc, assigned_zone, confidence_score, confidence_type, classification_reason, processing_profile_version`

- Only `ACCEPTED` EPCs; the Sales Floor/Back Room files include every zone of that type.
- `confidence_score`: 0–100 heuristic evidence score; empty when `confidence_type` is `RULE_BASED_NO_SCORE`.
- `processing_profile_version`: `<profile>@v<version>/<rules version>`.

### `exceptions.csv`

`job_id, store_id, epc, observed_zones, classification, confidence_score, confidence_type, reason_code, reason_description, recommended_action, evidence_available, requires_manual_review, affected_zone, suggested_zone`

One row per review EPC, per primary exclusion, and per zone an accepted EPC was excluded from. `affected_zone` and `suggested_zone` are additional columns appended after the required ones.

### `processing_summary.csv` — one row

`job_id, store_id, input_file_count, input_row_count, valid_row_count, invalid_row_count, unique_epc_count, duplicate_observation_count, accepted_count_by_zone, review_count, rejected_from_zone_count, multi_zone_epc_count, processing_status, processing_profile_version, created_at, completed_at, anchor_epc_count, malformed_epc_count, schema_version`

`accepted_count_by_zone` is `CODE:count|CODE:count`. The last three columns are additions.
