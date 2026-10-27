# Calibration and accuracy

## What is (and is not) claimed

- The classifier is an explainable heuristic with **uncalibrated default thresholds**.
- The 0–100 value is a **heuristic evidence score**, not a probability.
- The business target (≥ 95% genuine-item recall while controlling cross-zone false acceptance) is a **validation objective**. It has **not** been demonstrated: no real Zebra RFD40 data has been evaluated yet.
- Tests use synthetic data from a crude RF simulation (`scripts/lib/synthetic.ts`). They verify logic, not real-world accuracy.
- Metrics from unlabeled production scans are operational indicators only. The UI shows "Not available — labeled ground truth required" for accuracy metrics without labels.

## Metric definitions

For zone _z_, with labels from physical verification:

- **Genuine-item recall** = labeled EPCs truly in _z_ that were **accepted into _z_** ÷ all labeled EPCs truly in _z_ (including labeled EPCs that were never scanned, so reader misses lower recall).
- **Cross-zone false acceptance rate** = labeled EPCs accepted into _z_ whose true zone is not _z_ ÷ labeled EPCs accepted into _z_.
- **Precision** = 1 − false acceptance rate (on labeled EPCs).
- **Raw baseline**: the same metrics where every observed zone counts as an assignment (what the store sees today).
- **Uncertain rate**: labeled, observed EPCs left in review ÷ labeled observed EPCs. **Classification coverage** = 1 − uncertain rate.
- **Confusion matrix**: actual zone × outcome (each zone, `NEEDS_REVIEW`, `REJECTED_ONLY`, `NOT_OBSERVED`).

Operational (unlabeled) indicators per job: excluded % per zone, multi-zone overlap rate, review rate, share of EPCs missing useful evidence, reason and confidence-type distributions.

## Collecting labeled data

1. Pick a pilot store and run the normal scans (both zones, same inventory cycle).
2. Physically verify a sample of EPCs: random items from each zone, **plus** deliberately chosen boundary items (doorways, shared walls, high shelves near the back room), known cross-read examples and ambiguous cases. Record `epc, actual_zone, category, notes`.
3. Upload labels in **Reports → Calibration and ground-truth datasets**, linked to the job that processed those scans.
4. Use separate collections for tuning and evaluation:
   - **CALIBRATION** datasets: used for threshold suggestions only.
   - **GROUND_TRUTH** datasets: used for evaluation only. The system refuses to evaluate with a calibration dataset.
   - Prefer different days or scan sessions (or stores) for the two, to limit leakage.

Suggested minimum sizes: at least 30 genuine and 30 cross-read examples per zone for threshold suggestions (enforced); several hundred labeled EPCs per zone, including ≥ 100 boundary items, before quoting recall or false-acceptance figures. Small label sets are flagged in the UI.

## Leakage controls

- Labels are read only by `evaluate()` and `suggestCalibration()`, after classification; the engine API has no way to receive them during inference.
- Labels must come from physical verification, never from this system's output.
- A profile version records `tunedFromJobIds`; evaluating a job that informed its own profile is flagged **IN-SAMPLE — NOT A HOLDOUT ESTIMATE**.

## Calibration workflow

1. Process the calibration scan job with the default profile.
2. Upload a CALIBRATION dataset linked to the job; open **Threshold suggestions**. You get per zone: genuine RSSI p10, cross-read RSSI p90, a suggested weak-signal threshold only if the two are separable, and, for multi-zone EPCs, the 10th-percentile RSSI margin and how often RSSI pointed to the wrong zone.
3. An administrator creates a new profile version in **Settings** (set zone thresholds, consider enabling the calibrated weak-signal rule, adjust the RSSI margin or anchor reliability), listing the calibration job under "tuned from jobs".
4. Process a **different** scan job with the new profile and evaluate it against an independent GROUND_TRUTH dataset.
5. Compare against the raw baseline and the previous profile version. Only promote the profile to default if recall improves or holds and false acceptance falls.

Anchor reliability: estimate how often each registered anchor is read in its own zone versus the other zone across labeled sessions; keep `anchors.reliability` low until anchors are shown to help.

## Reporting results

Report recall and false acceptance per zone with the label count, category mix, collection dates, profile version and rules version. Do not generalize one store's results to others without evaluation there.
