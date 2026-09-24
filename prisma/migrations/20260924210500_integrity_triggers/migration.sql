-- Defence-in-depth integrity rules enforced by the database itself, so that no
-- application bug can silently rewrite evidence.

-- 1. Audit logs, document events, status history and signatures are append-only.
CREATE OR REPLACE FUNCTION dealdocs_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION dealdocs_forbid_mutation();

CREATE TRIGGER document_events_append_only
  BEFORE UPDATE OR DELETE ON "document_events"
  FOR EACH ROW EXECUTE FUNCTION dealdocs_forbid_mutation();

CREATE TRIGGER document_status_changes_append_only
  BEFORE UPDATE OR DELETE ON "document_status_changes"
  FOR EACH ROW EXECUTE FUNCTION dealdocs_forbid_mutation();

CREATE TRIGGER signatures_append_only
  BEFORE UPDATE OR DELETE ON "signatures"
  FOR EACH ROW EXECUTE FUNCTION dealdocs_forbid_mutation();

-- 2. Locked (published / accepted / signed) document versions are immutable.
--    Only lifecycle bookkeeping may change: status (never away from SIGNED/ACCEPTED),
--    one-time attachment of generated PDFs, and completion timestamp.
CREATE OR REPLACE FUNCTION dealdocs_protect_locked_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."lockedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'IMMUTABLE_VERSION: locked document version % cannot be deleted', OLD."id"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."lockedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."data" IS DISTINCT FROM OLD."data"
     OR NEW."pricingConfig" IS DISTINCT FROM OLD."pricingConfig"
     OR NEW."totals" IS DISTINCT FROM OLD."totals"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."renderedHtml" IS DISTINCT FROM OLD."renderedHtml"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
     OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
     OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."templateVersionId" IS DISTINCT FROM OLD."templateVersionId"
     OR NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt"
     OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
     OR (OLD."pdfFileId" IS NOT NULL AND NEW."pdfFileId" IS DISTINCT FROM OLD."pdfFileId")
     OR (OLD."signedPdfFileId" IS NOT NULL AND NEW."signedPdfFileId" IS DISTINCT FROM OLD."signedPdfFileId")
     OR (OLD."status" IN ('SIGNED', 'ACCEPTED') AND NEW."status" IS DISTINCT FROM OLD."status")
  THEN
    RAISE EXCEPTION 'IMMUTABLE_VERSION: locked document version % cannot be modified', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_versions_protect_locked
  BEFORE UPDATE OR DELETE ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION dealdocs_protect_locked_version();

-- 3. Line items of a locked version are frozen too.
CREATE OR REPLACE FUNCTION dealdocs_protect_locked_line_items() RETURNS trigger AS $$
DECLARE
  target_version uuid;
  locked timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_version := OLD."versionId";
  ELSE
    target_version := NEW."versionId";
  END IF;

  SELECT "lockedAt" INTO locked FROM "document_versions" WHERE "id" = target_version;
  IF locked IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_VERSION: line items of locked version % cannot be changed', target_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."versionId" IS DISTINCT FROM NEW."versionId" THEN
    RAISE EXCEPTION 'IMMUTABLE_VERSION: line items cannot move between versions'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_line_items_protect_locked
  BEFORE INSERT OR UPDATE OR DELETE ON "document_line_items"
  FOR EACH ROW EXECUTE FUNCTION dealdocs_protect_locked_line_items();
