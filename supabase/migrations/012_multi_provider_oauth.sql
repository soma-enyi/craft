-- Migration 012: multi-provider OAuth token storage (#661)
--
-- Adds provider_connections JSONB column to profiles for storing non-GitHub
-- OAuth provider data (e.g. Stellar wallet public key).
--
-- Schema for provider_connections:
--   {
--     "stellar": {
--       "publicKey": "G...",
--       "connectedAt": "2026-01-01T00:00:00Z"
--     }
--   }
--
-- GitHub tokens continue to use the existing github_token_encrypted column.
-- No private keys are ever stored — Stellar integration stores only the
-- public key; the wallet signs transactions client-side.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS provider_connections JSONB DEFAULT NULL;

COMMENT ON COLUMN profiles.provider_connections IS
    'Isolated per-provider connection metadata. GitHub uses dedicated columns; '
    'other providers (e.g. Stellar wallet) store { publicKey, connectedAt } here.';
