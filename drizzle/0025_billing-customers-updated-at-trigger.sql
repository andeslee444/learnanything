CREATE TRIGGER billing_customers_set_updated_at BEFORE UPDATE ON "billing_customers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
