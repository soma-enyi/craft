-- Vercel Blue-Green Alias Promotion Strategy
--
-- Stores staging and production alias assignments for Vercel projects.
-- Enables atomic promotion of staging deployments to production with rollback capability.
--
-- Schema:
--   staging_deployment_id: ID of the current staging deployment
--   production_deployment_id: ID of the current production deployment
--   previous_production_deployment_id: ID of the previous production deployment (for rollback)
--
-- Access rules:
--   Service role can read/write (for deployment orchestration)
--   Authenticated users can read their own projects' alias state

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS staging_deployment_id TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS production_deployment_id TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS previous_production_deployment_id TEXT;

-- Index for quick lookup of deployments by alias state
CREATE INDEX IF NOT EXISTS idx_deployments_staging_deployment_id ON deployments(staging_deployment_id);
CREATE INDEX IF NOT EXISTS idx_deployments_production_deployment_id ON deployments(production_deployment_id);
CREATE INDEX IF NOT EXISTS idx_deployments_previous_production_deployment_id ON deployments(previous_production_deployment_id);
