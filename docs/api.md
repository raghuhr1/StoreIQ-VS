# API reference (v1)

Base path: `/api/v1`. JSON unless stated. All endpoints except login are tenant-scoped through the session; a tenant ID is **never** accepted from the client.

## Authentication

Cookie-based server-side sessions (`svs_session`, or `__Host-svs_session` in production): HttpOnly, SameSite=Lax, Secure in production. Absolute lifetime `SESSION_TTL_HOURS` (12 h) and idle timeout `SESSION_IDLE_MINUTES` (120 min).

State-changing requests from browsers must be same-origin: an `Origin` that differs from `APP_URL`, or `Sec-Fetch-Site: cross-site`, is rejected with `CSRF_REJECTED`. Users with a pending temporary password can only call `POST /auth/password`.

API tokens for machine integrations are not part of the MVP.

## Conventions

- Success: `{ "data": ..., "meta"?: { "total", "limit", "offset", ... } }`.
- Error: `{ "error": { "code", "message", "details"?, "requestId" } }`. Every response has an `x-request-id` header; send your own to correlate.
- Pagination: `limit` (1–500, default 50) and `offset`.
- Write rate limit: `API_WRITE_RATE_LIMIT_PER_MIN` per user (default 120). Login: `LOGIN_RATE_LIMIT_PER_15MIN` per IP+email (default 10).

| Error code        | HTTP | Meaning                                                                |
| ----------------- | ---- | ---------------------------------------------------------------------- |
| UNAUTHENTICATED   | 401  | No or expired session; wrong credentials                               |
| FORBIDDEN         | 403  | Role lacks permission, or temporary password pending                   |
| CSRF_REJECTED     | 403  | Cross-site request                                                     |
| NOT_FOUND         | 404  | Missing **or belongs to another tenant** (indistinguishable by design) |
| CONFLICT          | 409  | Duplicate, invalid state (e.g. retrying a non-failed job)              |
| PAYLOAD_TOO_LARGE | 413  | Upload or body over limit                                              |
| UNSUPPORTED_FILE  | 415  | Not UTF-8 CSV text (binary, XLSX, wrong extension)                     |
| VALIDATION_ERROR  | 422  | Invalid input; `details` lists fields/rows                             |
| RATE_LIMITED      | 429  | Too many requests                                                      |
| INTERNAL          | 500  | Unexpected error (details logged server-side only)                     |

## Roles and permissions

| Permission                                               | ADMIN | MANAGER | OPERATOR | VIEWER |
| -------------------------------------------------------- | :---: | :-----: | :------: | :----: |
| Read dashboard, stores, jobs, results, anchors, profiles |   ✓   |    ✓    |    ✓     |   ✓    |
| Upload, map, create/retry jobs                           |   ✓   |    ✓    |    ✓     |        |
| Download outputs                                         |   ✓   |    ✓    |    ✓     |        |
| Stores/zones, anchors, calibration datasets, evaluations |   ✓   |    ✓    |          |        |
| Processing profiles                                      |   ✓   |         |          |        |
| Users, audit log                                         |   ✓   |         |          |        |

## Endpoints

### Auth

| Method | Path                  | Body / notes                                                             |
| ------ | --------------------- | ------------------------------------------------------------------------ |
| POST   | `/auth/login`         | `{ email, password }` → sets cookie; `{ mustChangePassword, expiresAt }` |
| POST   | `/auth/logout`        | Revokes the session                                                      |
| POST   | `/auth/password`      | `{ currentPassword, newPassword }` (≥ 12 chars); revokes other sessions  |
| POST   | `/auth/switch-tenant` | `{ tenantId }` — must be a membership                                    |
| GET    | `/auth/me`            | User, active tenant, role, permissions, memberships                      |

### Stores and configuration

| Method    | Path                                   | Body / notes                                                                    |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| GET/POST  | `/stores`                              | POST `{ name, code, timeZone }` creates Sales Floor and Back Room zones         |
| GET/PATCH | `/stores/{storeId}`                    | PATCH `{ name?, code?, timeZone? }`                                             |
| POST      | `/stores/{storeId}/zones`              | `{ code, name, type, aliases?, sortOrder? }`                                    |
| PATCH     | `/stores/{storeId}/zones/{zoneId}`     | `{ name?, type?, aliases?, sortOrder?, active? }` (code is fixed)               |
| PUT       | `/stores/{storeId}/relationships`      | `{ fromZoneId, toZoneId, relation: ADJACENT\|DOORWAY\|SHARED_WALL\|SEPARATED }` |
| GET/POST  | `/stores/{storeId}/anchors`            | POST `{ epc, zoneId, description? }`                                            |
| PATCH     | `/stores/{storeId}/anchors/{anchorId}` | `{ active }`                                                                    |

### Uploads and mapping

| Method     | Path                                                | Body / notes                                                                                                                                                                                             |
| ---------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST       | `/uploads?storeId=&filename=&zoneId=&sessionLabel=` | **Raw CSV bytes** as the body (streamed; `content-type: text/csv`). `zoneId` assigns the whole file to a zone. → `{ upload, duplicateOf }`                                                               |
| GET        | `/uploads?storeId=`                                 | Paginated                                                                                                                                                                                                |
| GET        | `/uploads/{id}/preview`                             | Headers, 20 sample rows, suggested mapping with scores, matching saved mappings, zones                                                                                                                   |
| POST       | `/uploads/{id}/validate`                            | `{ mapping: { epc, zone?, … }, zoneValueMap?: { "<value>": "<zoneId>" }, dateFormat?: AUTO\|ISO\|MDY\|DMY\|EPOCH_S\|EPOCH_MS }` → counts, issue counts, sample issues, zone values, mapped preview, `ok` |
| GET/POST   | `/mapping-profiles`                                 | POST `{ name, storeId?, exportFormat?, mapping, zoneValueMap?, dateFormat? }`                                                                                                                            |
| PUT/DELETE | `/mapping-profiles/{id}`                            |                                                                                                                                                                                                          |

### Processing

| Method | Path                                                             | Body / notes                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/jobs`                                                          | `{ storeId, inputs: [{ uploadId, mapping, zoneValueMap?, dateFormat? }], processingProfileId?, force? }`. Optional `Idempotency-Key` header (8–100 chars `[A-Za-z0-9_-]`). → 202 `{ id, status, deduplicated:false }`, or 200 with `deduplicated:true` when the same key or identical inputs already have a non-failed job. Two uploads with identical content in one job → 409. |
| GET    | `/jobs?storeId=&status=`                                         | Paginated                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/jobs/{id}`                                                     | Status, `progress` (0–100), `stage`, `rowsProcessed`, `errorMessage`, warnings, inputs, sessions, outputs, metrics, `profileVersion`                                                                                                                                                                                                                                             |
| POST   | `/jobs/{id}/retry`                                               | Failed jobs only; discards partial results                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/jobs/{id}/results?classification=&zoneId=&reasonCode=&search=` | Classification results                                                                                                                                                                                                                                                                                                                                                           |
| GET    | `/jobs/{id}/exceptions?zoneId=&reasonCode=&search=`              | Review items and exclusions; `meta.byReason`                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/jobs/{id}/observed?zoneId=&search=`                            | EPC×zone summaries                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/jobs/{id}/row-errors`                                          | Rejected rows and warnings (capped at `MAX_STORED_ROW_ERRORS`)                                                                                                                                                                                                                                                                                                                   |
| GET    | `/jobs/{id}/epcs/{epc}`                                          | Result, summaries and up to 500 source rows                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/jobs/{id}/outputs/{kind}`                                      | `observed_inventory`, `cleaned_sales_floor`, `cleaned_back_room`, `cleaned_zone_<code>`, `exceptions`, `processing_summary` (a `.csv` suffix is accepted). Proxied for local storage; 302 to a presigned URL (60 s) for S3. Audited.                                                                                                                                             |

### Calibration and evaluation

| Method   | Path                                                                            | Body / notes                              |
| -------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| GET      | `/calibration/datasets?storeId=`                                                |                                           |
| POST     | `/calibration/datasets?storeId=&name=&purpose=CALIBRATION\|GROUND_TRUTH&jobId=` | Raw label CSV body (≤ 20 MB)              |
| GET      | `/calibration/datasets/{id}/suggestions`                                        | Calibration datasets linked to a job only |
| GET/POST | `/jobs/{id}/evaluations`                                                        | POST `{ datasetId }` (GROUND_TRUTH only)  |

### Administration and operations

| Method       | Path                                | Notes                                                                                                                                                                   |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET/POST     | `/processing-profiles`              | POST `{ name, config (partial, merged over defaults), notes?, isDefault?, storeId?, tunedFromJobIds? }` creates a new immutable version; `meta.defaults` holds defaults |
| POST         | `/processing-profiles/{id}/default` |                                                                                                                                                                         |
| GET/POST     | `/users`                            | POST `{ email, name, role }` → `temporaryPassword` once for new accounts                                                                                                |
| PATCH/DELETE | `/users/{userId}`                   | PATCH `{ role?, disabled? }`; the last admin cannot be removed                                                                                                          |
| GET          | `/audit-events?action=`             | Paginated                                                                                                                                                               |
| GET          | `/dashboard`                        | Dashboard aggregates                                                                                                                                                    |
| GET          | `/api/health`                       | Liveness (no dependencies)                                                                                                                                              |
| GET          | `/api/ready`                        | Database, storage, worker heartbeat, queue depth; 503 when not ready                                                                                                    |

## Example

```bash
# Upload a Sales Floor export, then create a job
curl -b cookies.txt -H 'Origin: https://svs.example.com' -H 'content-type: text/csv' \
  --data-binary @sales_floor.csv \
  'https://svs.example.com/api/v1/uploads?storeId=<store>&filename=sales_floor.csv&zoneId=<salesFloorZone>'

curl -b cookies.txt -H 'Origin: https://svs.example.com' -H 'Idempotency-Key: nightly-2026-10-27-store-12' \
  -H 'content-type: application/json' \
  -d '{"storeId":"<store>","inputs":[{"uploadId":"<upload>","mapping":{"epc":"EPC","rssi":"Peak RSSI","timestamp":"Timestamp"}}]}' \
  https://svs.example.com/api/v1/jobs
```
