# Security and tenant isolation

## Tenant isolation (defence in depth)

1. **Database-enforced (PostgreSQL row-level security).** Every tenant data table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a policy `tenantId = current_setting('app.tenant_id', true)` for reads and writes (`prisma/migrations/*_row_level_security`). The application connects as `vshield_app`, which is not the table owner and has no `BYPASSRLS`. `withTenant()` sets `app.tenant_id` with `set_config(..., true)`, which is transaction-local, so pooled connections cannot leak context. Without a context, queries return no rows and inserts fail (fail closed).
2. **Tenant derived from the session only.** The active tenant is stored on the server-side session and re-validated against the user's memberships on every request. Request bodies never carry a tenant ID.
3. **Explicit tenant filters** in every service query, and object lookups return `NOT_FOUND` for other tenants' IDs (no existence oracle).
4. **Composite foreign keys** `(id, tenantId)` between stores, zones, uploads, jobs, results and datasets: a row cannot reference another tenant's row even through a bug.
5. **Background jobs.** The queue table holds only identifiers. The worker loads the job inside the queue item's tenant context and refuses mismatches (`JobInputError`); inputs must belong to the job's tenant and store.
6. **Storage.** Object keys are built server-side from UUIDs: `tenants/<tenantId>/uploads/<uploadId>.csv` and `tenants/<tenantId>/jobs/<jobId>/outputs/<file>`. Key segments are allow-listed, and the local driver verifies the resolved path stays inside its root. Files are only reachable through authorized endpoints; S3 downloads use 60-second presigned URLs issued after authorization and auditing.

Not under RLS (needed before a tenant context exists; accessed only by explicit filters): `Tenant`, `User`, `Membership`, `Session`, `JobQueue`, `WorkerHeartbeat`, `RateLimitBucket`.

Calibration data and labels are tenant- and store-scoped; nothing is shared or reused across tenants.

## Authentication and sessions

- scrypt (N=2¹⁵, r=8, p=1) password hashes; constant-time comparison; equal timing for unknown users.
- Password policy: ≥ 12 characters, small deny list, not containing the email name (NIST 800-63B style).
- 256-bit random session tokens; only SHA-256 hashes are stored; HttpOnly, SameSite=Lax, Secure and `__Host-` prefix in production; absolute and idle expiry; other sessions revoked on password change and when a user is disabled.
- Admin-created users get a one-time temporary password and must change it before using the API.
- Login rate limit per IP+email; per-user write rate limit (stored in PostgreSQL, shared across instances).

## Web protections

- CSRF: SameSite=Lax cookies + Origin / `Sec-Fetch-Site` checks on state-changing requests.
- XSS: React escaping; no user content rendered as HTML; CSP `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`. (`script-src` needs `'unsafe-inline'` because no per-request nonce middleware is used; adding nonces is a hardening item.)
- Headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy`, HSTS in production; `X-Powered-By` disabled; API responses `cache-control: no-store`.
- SQL injection: Prisma parameterized queries; the few raw queries use tagged templates (parameterized).
- Validation: zod schemas on every API input; structured errors without stack traces.

## Upload safety

- Streaming size limit (`MAX_UPLOAD_BYTES`) enforced while reading; `.csv`/`.txt` extension required.
- Content checks: no NUL bytes, not ZIP/XLSX, strict UTF-8 decoding of the whole stream, a non-empty header row.
- Filenames are reduced to a sanitized basename for display only; storage paths never use them.
- Row limit per job, per-record size limit (1 MB), processing timeout, capped stored row errors.
- Files are written mode 0600 locally; S3 objects use SSE (AES256).

## Exported files

Spreadsheet formula injection is neutralized: text cells beginning with `= + - @ \t \r` are prefixed with `'`. See [csv-format.md](csv-format.md).

## Audit

Append-only `AuditEvent` (UPDATE/DELETE revoked from the app role): logins, password changes, tenant creation, store/zone/anchor/profile/mapping changes, uploads, job creation/retry/completion/failure, downloads, evaluations, dataset uploads, membership changes, retention cleanups. Events carry actor, target, request ID and IP. Metadata holds identifiers and counts only, never RFID rows or secrets.

## Logging

Structured JSON logs with request IDs; keys resembling passwords, tokens, cookies or sessions are redacted; EPCs and raw rows are not logged.

## Secrets and encryption

- Secrets only via environment variables or a secrets manager; `.env*` is git-ignored; `.env.example` contains placeholders.
- In transit: terminate TLS at the load balancer/ingress; use `sslmode=require` (or stricter) in database URLs.
- At rest: managed PostgreSQL storage encryption and S3 SSE (or KMS); encrypted volumes for local storage.

## Automated security tests

`tests/security/` (run with `npm run test:integration`): cross-tenant reads, writes and downloads; identical EPCs in two tenants; raw-SQL RLS checks without context and with the wrong context; append-only audit; forged background-job tenant; storage path traversal; RBAC per role; temporary-password gate; session expiry, idle timeout and forged tokens; login rate limiting; CSRF; binary/XLSX/non-UTF-8/empty/oversized uploads; filename traversal; formula injection end to end.

## Residual risks / hardening backlog

- CSP nonces (remove `'unsafe-inline'` for scripts).
- MFA / SSO (SAML/OIDC) for enterprise tenants.
- Malware scanning of uploads if files are ever shared beyond processing.
- External penetration test before production.
- S3 driver and Docker deployment need validation in the target environment.
