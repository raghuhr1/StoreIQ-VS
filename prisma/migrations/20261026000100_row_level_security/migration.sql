-- Tenant isolation enforced by PostgreSQL row-level security.
--
-- The application connects as the non-owner role "vshield_app" and runs every
-- tenant-scoped query inside a transaction that first executes
--   SELECT set_config('app.tenant_id', <tenantId>, true)
-- (see src/server/db.ts withTenant). Rows of other tenants are invisible and
-- cannot be written. If the setting is absent, current_setting() returns NULL
-- or '' and no rows match (fail closed).
--
-- The role is created NOLOGIN here; scripts/setup-db-roles.ts (or your
-- infrastructure tooling) grants LOGIN and sets its password per environment.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vshield_app') THEN
    CREATE ROLE vshield_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO vshield_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vshield_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vshield_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM vshield_app;

-- Audit log is append-only for the application.
REVOKE UPDATE, DELETE ON TABLE "AuditEvent" FROM vshield_app;


ALTER TABLE "Store" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Store" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Store"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Zone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Zone" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Zone"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ZoneRelationship" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ZoneRelationship" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ZoneRelationship"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Upload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Upload" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Upload"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ColumnMappingProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ColumnMappingProfile" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ColumnMappingProfile"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ProcessingProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProcessingProfile" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProcessingProfile"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ProcessingJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProcessingJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProcessingJob"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "JobUpload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobUpload" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "JobUpload"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ScanSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ScanSession"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "RawObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RawObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RawObservation"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "RowError" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RowError" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RowError"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "EpcZoneSummary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EpcZoneSummary" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EpcZoneSummary"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ClassificationResult" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassificationResult" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ClassificationResult"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "JobOutput" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobOutput" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "JobOutput"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "ProcessingMetrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProcessingMetrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProcessingMetrics"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "AnchorTag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AnchorTag" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AnchorTag"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "CalibrationDataset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalibrationDataset" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CalibrationDataset"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "GroundTruthLabel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GroundTruthLabel" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "GroundTruthLabel"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "Evaluation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Evaluation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Evaluation"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditEvent"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
