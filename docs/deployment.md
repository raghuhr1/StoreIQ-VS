# Deployment and operations

## Components

| Component      | Command                                                                     | Scaling                                                                              |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Web/API        | `npm run build && npm start` (or the Docker image's default command)        | Stateless; run ≥ 2 behind a TLS load balancer                                        |
| Worker         | `npm run worker` (`node node_modules/tsx/dist/cli.mjs src/worker/index.ts`) | ≥ 1; `WORKER_CONCURRENCY` lanes per process; many processes are safe (`SKIP LOCKED`) |
| PostgreSQL     | 16+ (tested on 18)                                                          | Managed service recommended (encryption at rest, PITR backups)                       |
| Object storage | S3-compatible private bucket                                                | Block public access; SSE or KMS                                                      |

## Environment variables

See `.env.example` for the full list with defaults. Required in production: `DATABASE_URL` (the `vshield_app` role), `APP_URL` (exact public origin, used for CSRF checks), `STORAGE_DRIVER=s3` with `S3_BUCKET` and `S3_REGION` (credentials via IAM role / workload identity preferred), and `MIGRATION_DATABASE_URL` + `APP_DB_PASSWORD` for the migration step only. Never put the owner credentials in the web or worker environment.

## First deployment

1. Create the database and an owner role (e.g. `vshield_owner`).
2. Run migrations as the owner: `MIGRATION_DATABASE_URL=... npm run db:migrate`. This creates tables, RLS policies, and the `vshield_app` role (NOLOGIN).
3. Enable login for the app role: `MIGRATION_DATABASE_URL=... APP_DB_PASSWORD=<≥16 chars> npm run db:setup-roles` (or grant it with your infrastructure tooling).
4. Deploy web and worker with `DATABASE_URL=postgresql://vshield_app:<password>@host/db?sslmode=require`.
5. Create the first tenant and administrator from a trusted shell:
   ```bash
   npm run tenant:create -- --name "Acme Retail" --slug acme --email admin@acme.example --admin-name "Jane Doe"
   ```
   A one-time temporary password is printed (the admin must change it at first sign-in), or set `ADMIN_PASSWORD` in that shell's environment. Never pass passwords as arguments.
6. Check `GET /api/ready` → `{"status":"ready","checks":{"database":"ok","storage":"ok","worker":"ok"}}`.

### Docker Compose (staging)

`docker-compose.yml` defines `db`, a one-shot `migrate` job, `web` and `worker` from one image. Set `POSTGRES_OWNER_PASSWORD`, `APP_DB_PASSWORD` and the `.env` values, then run `docker compose up --build`. **These files were written but not executed in the build environment (no Docker available); validate them before use.**

## Upgrades

1. Back up the database.
2. Run `npm run db:migrate` with the owner URL. New migrations must keep RLS policies on any new tenant table and `GRANT` them to `vshield_app`.
3. Roll out web, then workers. Workers finish their current job on SIGTERM. Jobs interrupted by a crash are reclaimed after the stale-lock timeout and re-run idempotently.

## Health, monitoring and logs

- `GET /api/health`: liveness. `GET /api/ready`: DB, storage, worker heartbeat (< 60 s) and queue depth; returns 503 when DB or storage are down.
- Logs: JSON lines on stdout/stderr with `requestId`, method, path, status and duration; job completion/failure with counts and duration. Ship them to your log platform.
- Alert on: `/api/ready` failures, stale worker heartbeat, queue depth growing, jobs in `FAILED`, p95 job duration, 5xx rate.
- Useful SQL (as owner): `SELECT status, count(*) FROM "JobQueue" GROUP BY 1;` and `SELECT * FROM "WorkerHeartbeat";`.

## Failed jobs: recovery

- **Input errors** (wrong mapping, too many invalid rows, missing header, file removed by retention) fail immediately with the reason on the job page. Fix the mapping or files and create a new job; retrying unchanged input fails the same way.
- **Transient errors** (database or storage unavailable) are retried automatically up to 3 attempts with backoff, then marked `FAILED`. Use **Retry job** on the job page (or `POST /api/v1/jobs/{id}/retry`) once the dependency is healthy. Retries discard partial results first, so they never duplicate output.
- **Worker crash**: the job's lock is reclaimed after `JOB_TIMEOUT_SECONDS + 120 s` and processing restarts.

## Retention

The worker runs retention hourly:

- `RETENTION_UPLOAD_FILES_DAYS` (default 30): deletes source CSV files from storage and marks the upload `FILE_DELETED`.
- `RETENTION_RAW_OBSERVATIONS_DAYS` (default 30): deletes raw source rows of completed jobs older than the limit.
- Kept: classification results, EPC×zone summaries, output files, metrics, evaluations and audit events. Set either value to `0` to disable that cleanup. Each cleanup is audited.

## Backup and recovery

- PostgreSQL: daily full backups plus point-in-time recovery (WAL archiving); test restores quarterly.
- Object storage: bucket versioning and a lifecycle rule for non-current versions; replicate cross-region if required.
- Restore order: database → storage → web/worker. After a point-in-time restore, outputs referenced by `JobOutput` must exist in storage; re-run affected jobs if not.

## Piloting with a real Zebra RFD40 export

1. Obtain one Sales Floor and one Back Room export from the pilot store's normal process, with no workflow changes.
2. Remove or replace sensitive data before sharing (store names, staff IDs). EPCs of store merchandise are generally not personal data, but confirm with the customer.
3. Upload both files in the wizard; check the suggested mapping, especially EPC format (hex vs URN), RSSI units/sign, timestamp format and time zone, whether rows are per read or aggregated, and whether read counts exist.
4. If headers are not recognised, add aliases to `FIELD_ALIASES` in `src/engine/mapping.ts` (with a unit test) and save a mapping profile named after the export format.
5. Adjust the EPC profile if needed (e.g. `ANY` for URN identifiers, different length rules).
6. Add a sanitized sample as a test fixture only if it contains no customer-sensitive information.
7. Run the job and review warnings (NO_RSSI, TIMESTAMPS_NOT_PER_READ, NO_READ_EVIDENCE) to see which evidence the export actually provides.
8. Collect labeled calibration and ground-truth samples ([calibration-and-accuracy.md](calibration-and-accuracy.md)), tune, and evaluate on an independent day before relying on cleaned counts.

## Known limitations

- Real RFD40 export format not yet validated; synthetic fixtures only.
- XLSX not supported; S3 driver and Docker files not executed in the build environment.
- No SSO/MFA, no email delivery (temporary passwords are shown once to the admin), no machine API tokens.
- Full-pipeline throughput is dominated by raw-row inserts (~8k rows/s measured locally); use `COPY` if faster turnaround is needed.
- Per-job memory grows with unique EPC×zone pairs and RSSI samples (about 1 GB peak RSS at ~1M rows in the engine benchmark, which also held the synthetic input in memory). Size workers accordingly.
- CSP allows inline scripts (no nonce middleware).
