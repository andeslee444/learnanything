-- Custom SQL migration file, put your code below! --

CREATE TRIGGER topic_dossiers_set_updated_at BEFORE UPDATE ON "topic_dossiers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
