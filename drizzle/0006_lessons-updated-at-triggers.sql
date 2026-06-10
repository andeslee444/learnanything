CREATE TRIGGER lessons_set_updated_at BEFORE UPDATE ON "lessons" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER shared_lessons_set_updated_at BEFORE UPDATE ON "shared_lessons" FOR EACH ROW EXECUTE FUNCTION set_updated_at();