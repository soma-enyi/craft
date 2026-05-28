-- GitHub App installations table
CREATE TABLE github_app_installations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    installation_id BIGINT NOT NULL UNIQUE,
    app_id BIGINT NOT NULL,
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
    account_id BIGINT NOT NULL,
    repositories JSONB NOT NULL DEFAULT '[]'::jsonb,
    organizations JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    deleted_at TIMESTAMPTZ
);

-- Index for fast lookups by installation_id
CREATE INDEX idx_github_app_installations_installation_id ON github_app_installations(installation_id);
CREATE INDEX idx_github_app_installations_account_login ON github_app_installations(account_login);
CREATE INDEX idx_github_app_installations_deleted_at ON github_app_installations(deleted_at);

-- Apply updated_at trigger
CREATE TRIGGER update_github_app_installations_updated_at BEFORE
UPDATE ON github_app_installations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
