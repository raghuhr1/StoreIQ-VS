# RFID cleaning rules

Rule set version: **`svs-rules/1.0.0`** (`RULES_VERSION` in `src/engine/profile.ts`). Any change that can alter a classification for the same input and profile must bump this version.

The engine is deterministic: identical inputs and configuration produce identical results. It is a rules-based, explainable heuristic. It is **not** a trained or calibrated model.

## 1. Normalization (EPC)

- Trim whitespace; optionally strip a leading `0x`; optionally remove spaces, `-` and `:`.
- `HEX` profile (default): upper-case; must be hexadecimal; length 8–128; length a multiple of 4 (whole 16-bit words).
- `ANY` profile: printable ASCII, case preserved (e.g. EPC URNs).
- Values are **never** truncated, padded or stripped of leading zeros, so two different EPCs can never merge. The original value is kept (`epcRaw`).
- Malformed EPCs: `FLAG` (default) keeps them and sends them to review as `MALFORMED_EPC`; `REJECT` excludes the row.

## 2. Row validation

| Field                                     | Rule                                                                                                                                                               | Invalid value                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| EPC                                       | required                                                                                                                                                           | row rejected (`MISSING_EPC`)                      |
| Zone                                      | file-level assignment (separate files) or zone column (combined files); matched by explicit map, then code/name/alias, then type synonyms (e.g. `SF`, `Stockroom`) | row rejected (`UNKNOWN_ZONE`, `MISSING_ZONE`)     |
| Zone column in a zone-assigned file       | must agree with the file zone                                                                                                                                      | warning `ZONE_LABEL_CONFLICT`; EPC sent to review |
| Timestamp                                 | ISO 8601 (with or without offset), epoch s/ms, `D/M/Y` or `M/D/Y` only when unambiguous or explicitly chosen; offset-less values use the store time zone           | warning, value treated as missing                 |
| RSSI                                      | number within `validMin..validMax` (default −120..10 dBm)                                                                                                          | warning, treated as missing                       |
| Read count                                | positive integer                                                                                                                                                   | warning, treated as **unknown** (never zero)      |
| Phase, channel, Tx power, reader, antenna | recorded; phase is **not used** for classification                                                                                                                 | warning, treated as missing                       |
| Column count                              | must match header (trailing empty cells tolerated)                                                                                                                 | row rejected (`MALFORMED_ROW`)                    |

If more than `invalidRows.maxInvalidRowRatio` (default 50%) of rows are invalid, the job fails with an explanation: this almost always means a wrong mapping.

## 3. De-duplication

Exact duplicate rows (same EPC, zone, session, timestamp, RSSI, read count, phase, reader, antenna, channel, Tx power) are counted as `duplicate_observation_count`. Policy `AUTO` collapses them when the file has read counts or timestamps (an identical record twice is the same event); otherwise each identical row counts as another read. Unique-EPC counts are never affected: repeated reads are never separate inventory items.

## 4. Aggregation per EPC and zone

For each EPC×zone: row count; read count (sum of read counts, with each row lacking a count contributing **1** as a lower bound; `readCountComplete=false` flags this); distinct observation windows (`observationWindowSeconds`, default 5 s, only when per-read timestamps exist); first/last seen; RSSI count, median, p25, p75, min, max; readers; antennas; sessions; phase presence; label conflicts; data-quality status.

Per scan session: zones present, start/end time, rows, unique EPCs, registered anchor reads and their median RSSI.

Session pairs in different zones are classified as `OVERLAPPING`, `SEQUENTIAL`, `FAR_APART` (gap > `maxSessionGapHours`, default 24 h) or `UNKNOWN_TIMING` (no timestamps). Without timestamps the job reports that temporal inference is unavailable.

Evidence availability is decided per job: read counts are informative only if the file has read counts or more than one row per EPC×zone; observation windows only if timestamps are per read.

## 5. Classification

Every unique (non-anchor) EPC gets one primary classification:

- **ACCEPTED** — assigned to one zone (`assigned_zone`).
- **NEEDS_REVIEW** — insufficient or conflicting evidence. Not in any cleaned file.
- **REJECTED_FROM_ZONE** — excluded from a zone's cleaned inventory by an explicit rule. "Rejected" never means the item is absent from the store.

Per-zone dispositions are also recorded. A multi-zone EPC accepted in the Sales Floor is `REJECTED_FROM_ZONE` for the Back Room (`CROSS_READ_EXCLUDED`) and appears in `exceptions.csv` with `requires_manual_review=false`.

### Evidence components (score 0–100)

| Component                | Default weight           | Single-zone EPC                                                                    | Multi-zone EPC (candidate _c_ vs strongest other _o_)                                                        |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Exclusivity / read share | 0.40                     | 1.0 (only zone observed)                                                           | `(reads_c/(reads_c+reads_o) − 0.5)/0.5`; unavailable without read evidence                                   |
| Persistence              | 0.20                     | windows/`minWindowsForFullSupport` (3), else reads/`minReadsForFullSupport` (5)    | `pers_c × (1 − pers_o/2)`                                                                                    |
| RSSI                     | 0.25                     | only with a **calibrated** zone threshold: `0.5 + (median − threshold)/(2×margin)` | `(median_c − median_o)/marginForFullSupportDb` (10 dB), only when comparable (same reader or reader unknown) |
| Anchors                  | 0.15 × reliability (0.5) | see §6                                                                             | see §6                                                                                                       |

`score = 100 × Σ(weight × support) / Σ(weight)` over **available** components only. The `evidence_available` column always lists which evidence types existed, and the per-EPC detail view shows each component's support, weight and explanation.

Score bands (configurable): ≥ 85 high, 60–84 medium, < 60 low. Thresholds below 70 for acceptance are refused as unsafe.

### Decision rules (in order)

**Single zone**

1. Malformed EPC → review (`MALFORMED_EPC`, not scored).
2. Zone label conflict → review (`CONFLICTING_ZONE_LABELS`).
3. No signal evidence (EPC + zone only) → `ACCEPTED` by rule (`SINGLE_ZONE_RULE_ONLY`, **no score**, `confidence_type=RULE_BASED_NO_SCORE`); configurable to review instead.
4. Anchor support ≤ 0.2 → review (`ANCHOR_EVIDENCE_CONFLICT`).
5. If enabled and calibrated: median RSSI more than `margin` below the zone's calibrated weak threshold → `REJECTED_FROM_ZONE` (`WEAK_SIGNAL_BELOW_CALIBRATED_THRESHOLD`), manual review required.
6. Score ≥ acceptance threshold → `ACCEPTED` (`SINGLE_ZONE_STRONG_EVIDENCE`).
7. Persistence < 0.5 → review (`SPARSE_OBSERVATION`); otherwise review (`LOW_EVIDENCE_SCORE`).

**Multiple zones**

1. Malformed EPC, label conflicts → review.
2. Any pair of its sessions `FAR_APART` → review (`SESSIONS_NOT_CONTEMPORANEOUS`). Unrelated scans are never compared.
3. Zones configured as `SEPARATED` → review (`NON_ADJACENT_ZONES`).
4. Candidate = highest median RSSI when RSSI is comparable, else most reads.
5. No comparable RSSI and no read evidence → review (`MULTI_ZONE_NO_SIGNAL_EVIDENCE`) — conservative overlap detection for EPC+zone data.
6. Exact tie → review (`MULTI_ZONE_TIED`).
7. **Critical rules (override any score):** strongly persistent in both zones in sequential sessions → `POSSIBLE_MOVEMENT`; RSSI favours _c_ while ≥ 75% of reads are in _o_ → `CONFLICTING_SIGNAL_EVIDENCE`; anchor support ≤ 0.2 → `ANCHOR_EVIDENCE_CONFLICT`.
8. Minimum corroboration: comparable RSSI **plus** another evidence type, or read dominance ≥ `strongDominance` (0.9) with ≥ `minReadsForDominance` (5) reads. Otherwise review (`MULTI_ZONE_INSUFFICIENT_EVIDENCE`). RSSI alone never decides.
9. Score ≥ threshold → `ACCEPTED` in _c_ (`MULTI_ZONE_RESOLVED`), other zones `CROSS_READ_EXCLUDED`; else review (`MULTI_ZONE_AMBIGUOUS`).

Review items carry a `suggested_zone` (where the evidence leans), which is never used as an assignment.

### Safeguards

- Missing evidence is excluded from the score, never counted as support, and listed in `evidence_available`.
- No numeric score is produced from EPC+zone-only data.
- A high score never overrides a critical rule.
- Higher RSSI is not assumed to prove proximity: absolute RSSI is used only with store calibration, and relative RSSI only between comparable reads and with corroboration.
- Phase is recorded but not used until validated.
- The score is a **heuristic evidence score**, not a probability.

## 6. Anchor tags

Registered anchors (active, per store) are excluded from inventory and counted separately. For an EPC in zone _z_, each of its sessions contributes:

- Anchors of another zone heard with RSSI: EPC median > anchor + `marginDb` → 0.8; < anchor − margin → 0.15; otherwise 0.4.
- Anchors of another zone heard without RSSI → 0.4.
- Only own-zone anchors heard → 0.6.
- No registered anchors heard → no evidence (missing anchors are never evidence about reader location).

The anchor weight is multiplied by `anchors.reliability` (default 0.5) until calibration validates anchors. EPCs flagged as anchors in the file but not registered are excluded from inventory and not used as evidence.

## 7. Reason codes

| Code                                                                                                                                                                                                                                                                                                                                      | Classification              | Recommended action                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| SINGLE_ZONE_RULE_ONLY                                                                                                                                                                                                                                                                                                                     | ACCEPTED                    | None (no data to score)                               |
| SINGLE_ZONE_STRONG_EVIDENCE                                                                                                                                                                                                                                                                                                               | ACCEPTED                    | None                                                  |
| MULTI_ZONE_RESOLVED                                                                                                                                                                                                                                                                                                                       | ACCEPTED                    | None; spot-check during the pilot                     |
| CROSS_READ_EXCLUDED                                                                                                                                                                                                                                                                                                                       | per-zone REJECTED_FROM_ZONE | None                                                  |
| WEAK_SIGNAL_BELOW_CALIBRATED_THRESHOLD                                                                                                                                                                                                                                                                                                    | REJECTED_FROM_ZONE          | Verify location                                       |
| MALFORMED_EPC, CONFLICTING_ZONE_LABELS, SPARSE_OBSERVATION, LOW_EVIDENCE_SCORE, INSUFFICIENT_EVIDENCE, MULTI_ZONE_NO_SIGNAL_EVIDENCE, MULTI_ZONE_INSUFFICIENT_EVIDENCE, MULTI_ZONE_TIED, MULTI_ZONE_AMBIGUOUS, CONFLICTING_SIGNAL_EVIDENCE, POSSIBLE_MOVEMENT, SESSIONS_NOT_CONTEMPORANEOUS, ANCHOR_EVIDENCE_CONFLICT, NON_ADJACENT_ZONES | NEEDS_REVIEW                | See `RECOMMENDED_ACTIONS` in `src/engine/classify.ts` |

## 8. Changing the rules

Administrators change thresholds without code in **Settings → Processing profiles** (each save is a new immutable version, validated against unsafe combinations). Code changes to rule logic require bumping `RULES_VERSION`, updating this document and the scenario tests in `tests/unit/classification.test.ts`.
