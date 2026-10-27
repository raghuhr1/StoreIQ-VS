# Architecture

## Overview

```
 Browser ──HTTPS──▶ Next.js (App Router)
                     ├─ Server components (pages) ─┐
                     └─ /api/v1 route handlers ────┤
                                                   ▼
                              src/server (services, auth, RBAC, audit)
                               │            │                │
                               ▼            ▼                ▼
                         PostgreSQL     Object storage   src/engine (pure)
                        (RLS, queue)    (local / S3)          ▲
                               ▲                              │
                               └──── Worker (src/worker) ─────┘
```

| Layer   | Path                        | Responsibility                                                                                                                                                                                                                           |
| ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine  | `src/engine`                | Deterministic RFID cleaning: EPC normalization, CSV parsing, row mapping, aggregation, classification, metrics, exports, calibration suggestions. No framework, database, filesystem, clock or randomness. ESLint forbids those imports. |
| Server  | `src/server`                | Config, DB access (`withTenant`), sessions, RBAC, audit, storage drivers, services per domain, job queue and processor.                                                                                                                  |
| Web     | `src/app`, `src/components` | Server-rendered pages calling services directly; client components call `/api/v1`.                                                                                                                                                       |
| Worker  | `src/worker`                | Claims jobs, runs the processor, heart-beats, applies retention.                                                                                                                                                                         |
| Scripts | `scripts`                   | Embedded dev DB, tenant bootstrap, demo seed, fixtures, benchmarks, E2E harness.                                                                                                                                                         |

## Key decisions

1. **PostgreSQL-backed job queue instead of Redis.** Enqueue happens in the same transaction that creates the job, so a job can never be lost between DB and queue. Claiming uses `FOR UPDATE SKIP LOCKED`; locks are refreshed during long jobs and reclaimed after `JOB_TIMEOUT_SECONDS + 120 s` if a worker dies. Retries use exponential backoff for transient errors; input/configuration errors fail immediately with an actionable message. The interface (`src/server/jobs/queue.ts`) can be swapped for Redis/BullMQ if throughput ever requires it.
2. **Row-level security for tenant isolation.** The app connects as a non-owner role; every tenant table has a `FORCE`d policy on `app.tenant_id`, which `withTenant()` sets transaction-locally. Application queries also filter by `tenantId` (defence in depth). Composite `(id, tenantId)` foreign keys make cross-tenant references impossible.
3. **Server-side sessions without an auth framework.** 256-bit random tokens; only SHA-256 hashes are stored; scrypt password hashing (Node built-in). Absolute and idle expiry. This follows the Lucia/Oslo guidance and avoids coupling to a library's schema.
4. **Streaming everywhere for large inputs.** Uploads stream through size/UTF-8/binary checks into a private temp file before storage; processing streams CSV from storage through `csv-parse`. Memory grows with unique EPC×zone pairs and RSSI samples, not file size.
5. **Immutable, versioned processing profiles.** Each job references the exact profile version, and the engine exposes `RULES_VERSION`. Re-running a job reproduces byte-identical outputs except for the job timestamps.
6. **Outputs generated once, server-side.** CSVs are built from the saved processing result in the worker and stored; the browser only downloads them.
7. **Idempotent processing.** A job restart deletes any partial results for that job before writing; unique constraints (`jobId+epc`, `jobId+kind`) prevent duplicates. Job creation is protected by `Idempotency-Key` and an input hash.

## Processing pipeline

1. Worker claims a queue item and loads the job **inside the queue item's tenant context**; a mismatch fails the job (RLS hides foreign rows).
2. Partial results from previous attempts are removed.
3. Each input file is streamed: header → mapping check → per-row validation → `RawObservation` (batched 5,000) and `RowError` (capped) → aggregator.
4. Invalid-row ratio check (default 50%) protects against wrong mappings.
5. Classification, then `ScanSession`, `EpcZoneSummary`, `ClassificationResult` persisted in batches.
6. Exports written to storage at `tenants/<tenantId>/jobs/<jobId>/outputs/<file>`; metrics and job status committed together.

## Data model (main tables)

`Tenant`, `User`, `Membership` (role per tenant), `Session`, `Store`, `Zone`, `ZoneRelationship`, `Upload`, `ColumnMappingProfile`, `ProcessingProfile`, `ProcessingJob`, `JobUpload` (mapping snapshot), `JobQueue`, `ScanSession`, `RawObservation`, `RowError`, `EpcZoneSummary`, `ClassificationResult`, `JobOutput`, `ProcessingMetrics`, `AnchorTag`, `CalibrationDataset`, `GroundTruthLabel`, `Evaluation`, `AuditEvent`, `WorkerHeartbeat`, `RateLimitBucket`. Schema: `prisma/schema.prisma`; SQL: `prisma/migrations/`.

## Performance (measured, synthetic data)

Environment: Apple M5 (10 cores, 16 GB), macOS 26.6, Node 24.22.1, embedded PostgreSQL 18 on the same machine.

| Measurement                                                                                           | Result                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine only, 959,675 per-read rows → 117,956 EPCs (`npm run benchmark`)                               | 3.24 s parse+aggregate+classify (~296k rows/s), 0.24 s exports; peak RSS 1.1 GB, dominated by the generator holding the synthetic input in memory |
| Full pipeline incl. upload, DB persistence and exports, 958,722 rows / 70.6 MB (`large-file.test.ts`) | 119.9 s end to end (~8k rows/s)                                                                                                                   |

The full pipeline is dominated by inserting traceable `RawObservation` rows through Prisma `createMany`. If faster turnaround is needed, switch that step to PostgreSQL `COPY` or make raw-row persistence optional. These figures are not production capacity claims; re-measure on target infrastructure.
