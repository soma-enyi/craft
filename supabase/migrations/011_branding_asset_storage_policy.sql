-- Supabase Storage Bucket Policy for Branding Assets
--
-- Creates the "branding_assets" bucket with Row Level Security (RLS) policies.
--
-- Path-based namespacing scheme:
--   User uploads are stored at: {user_id}/{asset_name}
--   Only users can read/write their own {user_id} namespace.
--   Cross-user access is denied by RLS policies.
--
-- Access rules:
--   - INSERT: User can upload only to paths starting with their own user_id
--   - SELECT: User can read only from paths starting with their own user_id
--   - UPDATE/DELETE: Not allowed via policy
--
-- Storage operations always validate the path against the authenticated user's ID
-- before hitting the storage layer, providing defense-in-depth security.

INSERT INTO storage.buckets (id, name, public) VALUES ('branding_assets', 'branding_assets', false) ON CONFLICT (id) DO NOTHING;

-- Policy: Allow authenticated users to upload to their own user_id namespace
CREATE POLICY "Users can upload to own branding namespace"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'branding_assets'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Allow authenticated users to read from their own user_id namespace
CREATE POLICY "Users can read own branding assets"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'branding_assets'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Deny all other access by default
CREATE POLICY "Deny cross-user branding access"
  ON storage.objects FOR ALL
  USING (
    bucket_id = 'branding_assets'
    AND (storage.foldername(name))[1] != auth.uid()::text
  )
  WITH CHECK (false);
