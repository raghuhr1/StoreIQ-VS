# StoreIQ Simple Virtual Shield

**Scan normally. Clean virtually. Trust your inventory.**

An intelligent post-scan RFID zone-cleaning service that helps retailers reduce cross-zone inventory errors without changing their existing scanning workflow.

Store staff keep using the Zebra RFD40 handheld exactly as today (select zone → scan → export). They upload the exported CSV files here; the service identifies likely Sales Floor ↔ Back Room cross-reads, produces cleaned per-zone inventory files and flags uncertain EPCs for review. No new handheld app, SDK, firmware, extra scan or live device connection is required.

> **Status: MVP ready for internal pilot testing.** Classification is an explainable, rules-based heuristic. Its accuracy on real stores is **unknown** until it is evaluated against labeled ground truth from real RFD40 exports. The 95% genuine-item recall goal is a validation objective, not a claim. See [docs/calibration-and-accuracy.md](docs/calibration-and-accuracy.md).

## What it does

1. **Upload** separate zone files or one combined file (CSV; UTF-8 with or without BOM; `,` `;` tab or `|`; Windows or Unix line endings).
2. **Map columns** — automatic suggestions from header aliases and sample values; save reusable mapping profiles. Only EPC and a zone (column or whole-file assignment) are required.
3. **Validate** — row counts, actionable errors (missing EPC, unknown zone, ambiguous dates, invalid values, malformed rows), zone-value mapping.
4. **Process** asynchronously — normalization, de-duplication, EPC×zone aggregation, session timing analysis, classification (`ACCEPTED` / `NEEDS_REVIEW` / `REJECTED_FROM_ZONE`) with a heuristic evidence score and recorded reasons.
5. **Review** cleaned inventory, exceptions, observed inventory, rejected rows and per-EPC evidence with source-row traceability.
6. **Download** `observed_inventory.csv`, `cleaned_sales_floor.csv`, `cleaned_back_room.csv`, `exceptions.csv`, `processing_summary.csv` (plus one cleaned file per additional zone).
7. **Calibrate and evaluate** with physically verified labels: recall, precision, cross-zone false acceptance, confusion matrix, raw-vs-cleaned comparison, advisory threshold suggestions.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript 5.9 · PostgreSQL 16+ with row-level security · Prisma 7 · PostgreSQL-backed job queue + worker · local or S3-compatible private storage · Vitest, React Testing Library, Playwright. See [docs/architecture.md](docs/architecture.md).

## Local development

Requirements: Node.js ≥ 20.9 (developed on 24 LTS). Docker is **not** required: a real PostgreSQL server is run from the `embedded-postgres` dev dependency.

```bash
npm install                      # also runs `prisma generate`
cp .env.example .env             # then edit the passwords
npm run db:dev                   # terminal 1: PostgreSQL on :54329, applies migrations, configures the app role
npm run tenant:create -- --name "Acme Retail" --slug acme --email admin@acme.example --admin-name "Jane Doe"
                                 # prints a one-time temporary password (or set ADMIN_PASSWORD in the environment)
npm run dev                      # terminal 2: web app on http://localhost:3000
npm run worker                   # terminal 3: background processing
```

Optional demo data (clearly labelled **SAMPLE DATA**, synthetic): `ADMIN_PASSWORD='choose-a-long-password' npm run seed:demo`.

If you already have PostgreSQL, point `MIGRATION_DATABASE_URL` (schema owner) and `DATABASE_URL` (the `vshield_app` role) at it and run `npm run db:migrate && npm run db:setup-roles` instead of `db:dev`.

## Tests and checks

| Command                                                                       | What it runs                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm test`                                                                    | All Vitest suites (unit, integration, security). Starts a throw-away PostgreSQL automatically. |
| `SKIP_DB=1 npm run test:unit`                                                 | Engine and component unit tests only (no database).                                            |
| `npm run test:integration`                                                    | Integration + security suites against PostgreSQL.                                              |
| `LARGE_FILE_ROWS=1000000 npx vitest run tests/integration/large-file.test.ts` | Large-file pipeline benchmark.                                                                 |
| `npm run build && npm run test:e2e`                                           | Playwright end-to-end tests (needs `npx playwright install chromium` once).                    |
| `npm run lint` · `npm run typecheck` · `npm run build`                        | Static checks and production build.                                                            |
| `npm run benchmark -- --rows 1000000`                                         | Engine-only throughput benchmark.                                                              |
| `npm run fixtures:generate`                                                   | Regenerate the synthetic CSV fixtures in `tests/fixtures/`.                                    |

## Documentation

- [User guide](docs/user-guide.md)
- [Running on Linux](docs/linux-setup.md)
- [Implementation plan](docs/implementation-plan.md)
- [Architecture](docs/architecture.md)
- [RFID cleaning rules](docs/rfid-cleaning-rules.md)
- [CSV input and output formats](docs/csv-format.md)
- [API reference](docs/api.md)
- [Security and tenant isolation](docs/security-and-tenant-isolation.md)
- [Calibration and accuracy](docs/calibration-and-accuracy.md)
- [Deployment and operations](docs/deployment.md)

## Known limitations

- No real RFD40 export has been seen yet; mappings and fixtures are synthetic. See "Piloting with a real export" in [docs/deployment.md](docs/deployment.md).
- XLSX upload is not supported (export as CSV).
- The S3 storage driver and Docker artifacts were authored but not executed in the build environment.
- Users are provisioned by administrators with one-time temporary passwords; there is no email delivery, SSO or MFA yet.
- Heuristic thresholds are uncalibrated defaults until store calibration data is collected.
