CREATE TRIGGER concept_ability_set_updated_at BEFORE UPDATE ON "concept_ability" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER item_difficulty_set_updated_at BEFORE UPDATE ON "item_difficulty" FOR EACH ROW EXECUTE FUNCTION set_updated_at();