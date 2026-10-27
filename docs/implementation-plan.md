# Implementation Plan — StoreIQ Simple Virtual Shield

## 1. Repository assessment (Phase 1)

| Item                    | Finding                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing code           | None. `/Users/raghu/VShield` was empty and not a Git repository. Greenfield build.                                                                                                             |
| Toolchain on build host | No Node, Docker, PostgreSQL or Redis installed. System Python 3.9 and git only. Node 24 LTS installed user-locally at `~/.local/node` (checksum verified).                                     |
| Consequence             | A real PostgreSQL 18 server is run for development and tests through the `embedded-postgres` dev dependency. Docker Compose is provided for other environments but could not be executed here. |

## 2. Stack (greenfield, per brief §4, with documented deviations)

| Concern         | Choice                                                                                                    | Notes                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web + API       | Next.js 16 (App Router), React 19, TypeScript 5.9                                                         | TS 7 (native port) deliberately avoided until Next.js tooling support is verified.                                                                                         |
| Database        | PostgreSQL (16+; tested on 18) with row-level security                                                    | Prisma 7.10 ORM + `@prisma/adapter-pg`. Prisma 8 is still RC.                                                                                                              |
| Background jobs | **PostgreSQL-backed queue** (`FOR UPDATE SKIP LOCKED`) + separate worker process                          | Deviation from Redis: no extra infrastructure, enqueue is transactional with job creation, worker validates tenant ownership. Swappable behind `src/server/jobs/queue.ts`. |
| Auth            | Server-side sessions (random 256-bit token, SHA-256 hash stored), scrypt password hashing (Node built-in) | Follows the Lucia/Oslo session guidance without an extra dependency. HttpOnly, SameSite=Lax, Secure in production.                                                         |
| Storage         | Driver interface: local filesystem (dev) and S3-compatible (prod, private bucket, 60 s presigned URLs)    | S3 driver implemented but not integration-tested here (no S3 endpoint available).                                                                                          |
| CSV             | `csv-parse` streaming parser; hand-written exporter with formula-injection protection                     | XLSX intentionally deferred (optional in brief).                                                                                                                           |
| Validation      | `zod`                                                                                                     | Profiles, API payloads, env.                                                                                                                                               |
| Tests           | Vitest (unit, integration, security against real Postgres), React Testing Library, Playwright E2E         |                                                                                                                                                                            |

## 3. Module layout

```
src/engine/        Pure, deterministic RFID cleaning engine (no Next/Prisma imports)
src/server/        DB access (tenant-scoped), auth, RBAC, storage, services, job queue, processor
src/app/           Next.js UI pages and /api/v1 route handlers
src/worker/        Background worker entry point
scripts/           Dev DB, tenant bootstrap, demo seed, fixture generator, benchmark
tests/             unit / integration / security / e2e + synthetic fixtures
docs/              Architecture, rules, CSV format, API, security, calibration, deployment
```

## 4. Phases and status (as of 2026-10-27)

| Phase                                                                                                                                 | Status                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1. Assessment                                                                                                                         | Done (this document)      |
| 2. Foundation — schema, migrations, RLS, sessions, RBAC, stores/zones, users, audit                                                   | Done                      |
| 3. CSV ingestion — streaming upload, validation, preview, mapping suggestions, zone-value mapping, mapping profiles, patterns A and B | Done (XLSX deferred)      |
| 4. Engine — normalization, dedup, aggregation, session timing, classification, evidence score, exceptions, metrics, exports           | Done                      |
| 5. Processing and exports — idempotent jobs, retries, progress, five CSV outputs + summary                                            | Done                      |
| 6. UI — dashboard, upload wizard, jobs, inventory, exceptions, reports, configuration, users, audit, settings                         | Done                      |
| 7. Calibration and evaluation — labeled datasets, ground-truth metrics, suggestions, leakage guard                                    | Done                      |
| 8. Security and reliability — tenant isolation, upload abuse, CSV injection, large files, retries                                     | Done (see tests/security) |
| 9. Validation and handover — lint, format, typecheck, build, unit/integration/security/E2E tests, docs                                | Done                      |

Not done / blocked: validation against a real Zebra RFD40 export and labeled store data; execution of the Docker and S3 paths (unavailable in the build environment).

## 5. Safe defaults chosen for unknowns

- Real RFD40 export format unknown → configurable mapping with aliases; nothing beyond EPC + zone is assumed.
- EPC format → hex, separators/`0x` stripped, upper-cased, never truncated or zero-stripped; malformed EPCs flagged for review (configurable to reject).
- Missing read count → treated as "at least one read", never zero.
- EPC + zone only data → single-zone EPCs accepted by rule with **no numeric score**; multi-zone EPCs go to review.
- Confidence → called a _heuristic evidence score_; never presented as a probability.
- Accuracy metrics → shown only when a labeled ground-truth dataset is attached.
