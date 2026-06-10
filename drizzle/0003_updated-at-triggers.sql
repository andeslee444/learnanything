CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER missions_set_updated_at BEFORE UPDATE ON "missions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER glossary_terms_set_updated_at BEFORE UPDATE ON "glossary_terms" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER skill_nodes_set_updated_at BEFORE UPDATE ON "skill_nodes" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER reference_docs_set_updated_at BEFORE UPDATE ON "reference_docs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();