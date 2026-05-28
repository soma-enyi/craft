/**
 * GitHubAppInstallationService
 *
 * Handles GitHub App installation webhook events:
 * - installation.created: store installation ID, orgs, and repos
 * - installation.deleted: remove all installation records
 * - installation_repositories.added: update granted repositories
 * - installation_repositories.removed: update granted repositories
 *
 * All operations are idempotent using installation_id as the primary key.
 */

import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface InstallationCreatedPayload {
    action: 'created';
    installation: {
        id: number;
        app_id: number;
        account: {
            login: string;
            type: 'User' | 'Organization';
            id: number;
        };
        repositories?: Array<{
            id: number;
            name: string;
            full_name: string;
        }>;
        repository_selection: 'all' | 'selected';
        single_file_name?: string | null;
    };
    repositories?: Array<{
        id: number;
        name: string;
        full_name: string;
    }>;
}

export interface InstallationDeletedPayload {
    action: 'deleted';
    installation: {
        id: number;
        app_id: number;
        account: {
            login: string;
            type: 'User' | 'Organization';
            id: number;
        };
    };
}

export interface InstallationRepositoriesPayload {
    action: 'added' | 'removed';
    installation: {
        id: number;
        account: {
            login: string;
            type: 'User' | 'Organization';
            id: number;
        };
    };
    repository_selection: 'all' | 'selected';
    repositories_added?: Array<{
        id: number;
        name: string;
        full_name: string;
    }>;
    repositories_removed?: Array<{
        id: number;
        name: string;
        full_name: string;
    }>;
}

export class GitHubAppInstallationService {
    async handleInstallationCreated(payload: InstallationCreatedPayload): Promise<void> {
        const supabase = createClient();
        const installation = payload.installation;

        // Prepare repository list
        const repositories = (payload.repositories || []).map((repo) => ({
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
        }));

        // Prepare organization list (for organization-level installs)
        const organizations = installation.account.type === 'Organization'
            ? [{
                login: installation.account.login,
                id: installation.account.id,
                type: 'Organization',
            }]
            : [];

        // Upsert installation (idempotent via installation_id)
        const { error } = await supabase
            .from('github_app_installations')
            .upsert({
                installation_id: installation.id,
                app_id: installation.app_id,
                account_login: installation.account.login,
                account_type: installation.account.type,
                account_id: installation.account.id,
                repositories: repositories,
                organizations: organizations,
                deleted_at: null,
            }, {
                onConflict: 'installation_id',
            });

        if (error) {
            throw new Error(`Failed to create installation record: ${error.message}`);
        }
    }

    async handleInstallationDeleted(payload: InstallationDeletedPayload): Promise<void> {
        const supabase = createClient();
        const installation = payload.installation;

        // Mark installation as deleted (soft delete) to preserve audit trail
        const { error } = await supabase
            .from('github_app_installations')
            .update({
                deleted_at: new Date().toISOString(),
            })
            .eq('installation_id', installation.id);

        if (error) {
            throw new Error(`Failed to delete installation record: ${error.message}`);
        }
    }

    async handleInstallationRepositoriesAdded(payload: InstallationRepositoriesPayload): Promise<void> {
        const supabase = createClient();
        const installation = payload.installation;
        const addedRepos = (payload.repositories_added || []).map((repo) => ({
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
        }));

        // Get current installation record
        const { data: current, error: fetchError } = await supabase
            .from('github_app_installations')
            .select('repositories')
            .eq('installation_id', installation.id)
            .single();

        if (fetchError || !current) {
            throw new Error(`Installation not found: ${installation.id}`);
        }

        // Merge new repositories with existing ones (avoid duplicates)
        const existingRepos = (current.repositories as any[]) || [];
        const repoIds = new Set(existingRepos.map((r) => (r as any).id));
        const mergedRepos = [
            ...existingRepos,
            ...addedRepos.filter((r) => !repoIds.has(r.id)),
        ];

        // Update repositories
        const { error: updateError } = await supabase
            .from('github_app_installations')
            .update({
                repositories: mergedRepos,
            })
            .eq('installation_id', installation.id);

        if (updateError) {
            throw new Error(`Failed to update repositories: ${updateError.message}`);
        }
    }

    async handleInstallationRepositoriesRemoved(payload: InstallationRepositoriesPayload): Promise<void> {
        const supabase = createClient();
        const installation = payload.installation;
        const removedRepoIds = new Set(
            (payload.repositories_removed || []).map((repo) => repo.id)
        );

        // Get current installation record
        const { data: current, error: fetchError } = await supabase
            .from('github_app_installations')
            .select('repositories')
            .eq('installation_id', installation.id)
            .single();

        if (fetchError || !current) {
            throw new Error(`Installation not found: ${installation.id}`);
        }

        // Filter out removed repositories
        const existingRepos = (current.repositories as any[]) || [];
        const filteredRepos = existingRepos.filter((r) => !removedRepoIds.has((r as any).id));

        // Update repositories
        const { error: updateError } = await supabase
            .from('github_app_installations')
            .update({
                repositories: filteredRepos,
            })
            .eq('installation_id', installation.id);

        if (updateError) {
            throw new Error(`Failed to update repositories: ${updateError.message}`);
        }
    }
}

export const gitHubAppInstallationService = new GitHubAppInstallationService();
