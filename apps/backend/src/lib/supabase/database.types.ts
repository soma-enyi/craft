export type Json =
    | string
    | number
    | boolean
    | null
    | { [key: string]: Json | undefined }
    | Json[];

export interface Database {
    public: {
        Tables: {
            profiles: {
                Row: {
                    id: string;
                    subscription_tier: 'free' | 'pro' | 'enterprise';
                    subscription_status: 'active' | 'canceled' | 'past_due' | 'unpaid' | null;
                    stripe_customer_id: string | null;
                    stripe_subscription_id: string | null;
                    github_connected: boolean;
                    github_username: string | null;
                    github_token_encrypted: string | null;
                    github_token_expires_at: string | null;
                    github_token_refreshed_at: string | null;
                    provider_connections: Json | null;
                    created_at: string;
                    updated_at: string;
                };
                Insert: {
                    id: string;
                    subscription_tier?: 'free' | 'pro' | 'enterprise';
                    subscription_status?: 'active' | 'canceled' | 'past_due' | 'unpaid' | null;
                    stripe_customer_id?: string | null;
                    stripe_subscription_id?: string | null;
                    github_connected?: boolean;
                    github_username?: string | null;
                    github_token_encrypted?: string | null;
                    github_token_expires_at?: string | null;
                    github_token_refreshed_at?: string | null;
                    provider_connections?: Json | null;
                    created_at?: string;
                    updated_at?: string;
                };
                Update: {
                    id?: string;
                    subscription_tier?: 'free' | 'pro' | 'enterprise';
                    subscription_status?: 'active' | 'canceled' | 'past_due' | 'unpaid' | null;
                    stripe_customer_id?: string | null;
                    stripe_subscription_id?: string | null;
                    github_connected?: boolean;
                    github_username?: string | null;
                    github_token_encrypted?: string | null;
                    github_token_expires_at?: string | null;
                    github_token_refreshed_at?: string | null;
                    provider_connections?: Json | null;
                    created_at?: string;
                    updated_at?: string;
                };
            };
            templates: {
                Row: {
                    id: string;
                    name: string;
                    description: string | null;
                    category: 'dex' | 'lending' | 'payment' | 'asset-issuance';
                    blockchain_type: string;
                    base_repository_url: string;
                    preview_image_url: string | null;
                    customization_schema: Json;
                    is_active: boolean;
                    created_at: string;
                    updated_at: string;
                };
                Insert: {
                    id?: string;
                    name: string;
                    description?: string | null;
                    category: 'dex' | 'lending' | 'payment' | 'asset-issuance';
                    blockchain_type?: string;
                    base_repository_url: string;
                    preview_image_url?: string | null;
                    customization_schema: Json;
                    is_active?: boolean;
                    created_at?: string;
                    updated_at?: string;
                };
                Update: {
                    id?: string;
                    name?: string;
                    description?: string | null;
                    category?: 'dex' | 'lending' | 'payment' | 'asset-issuance';
                    blockchain_type?: string;
                    base_repository_url?: string;
                    preview_image_url?: string | null;
                    customization_schema?: Json;
                    is_active?: boolean;
                    created_at?: string;
                    updated_at?: string;
                };
            };
            deployments: {
                Row: {
                    id: string;
                    user_id: string;
                    template_id: string;
                    name: string;
                    customization_config: Json;
                    repository_url: string | null;
                    vercel_project_id: string | null;
                    vercel_deployment_id: string | null;
                    deployment_url: string | null;
                    custom_domain: string | null;
                    status: 'pending' | 'generating' | 'creating_repo' | 'pushing_code' | 'deploying' | 'completed' | 'failed';
                    error_message: string | null;
                    created_at: string;
                    updated_at: string;
                    deployed_at: string | null;
                };
                Insert: {
                    id?: string;
                    user_id: string;
                    template_id: string;
                    name: string;
                    customization_config: Json;
                    repository_url?: string | null;
                    vercel_project_id?: string | null;
                    vercel_deployment_id?: string | null;
                    deployment_url?: string | null;
                    custom_domain?: string | null;
                    status?: 'pending' | 'generating' | 'creating_repo' | 'pushing_code' | 'deploying' | 'completed' | 'failed';
                    error_message?: string | null;
                    created_at?: string;
                    updated_at?: string;
                    deployed_at?: string | null;
                };
                Update: {
                    id?: string;
                    user_id?: string;
                    template_id?: string;
                    name?: string;
                    customization_config?: Json;
                    repository_url?: string | null;
                    vercel_project_id?: string | null;
                    vercel_deployment_id?: string | null;
                    deployment_url?: string | null;
                    custom_domain?: string | null;
                    status?: 'pending' | 'generating' | 'creating_repo' | 'pushing_code' | 'deploying' | 'completed' | 'failed';
                    error_message?: string | null;
                    created_at?: string;
                    updated_at?: string;
                    deployed_at?: string | null;
                };
            };
            deployment_logs: {
                Row: {
                    id: string;
                    deployment_id: string;
                    stage: string;
                    message: string;
                    level: 'info' | 'warn' | 'error';
                    metadata: Json | null;
                    created_at: string;
                };
                Insert: {
                    id?: string;
                    deployment_id: string;
                    stage: string;
                    message: string;
                    level?: 'info' | 'warn' | 'error';
                    metadata?: Json | null;
                    created_at?: string;
                };
                Update: {
                    id?: string;
                    deployment_id?: string;
                    stage?: string;
                    message?: string;
                    level?: 'info' | 'warn' | 'error';
                    metadata?: Json | null;
                    created_at?: string;
                };
            };
            deployment_updates: {
                Row: {
                    id: string;
                    deployment_id: string;
                    user_id: string;
                    new_customization_config: Json;
                    previous_state: Json | null;
                    status: 'pending' | 'validating' | 'generating' | 'updating_repo' | 'redeploying' | 'completed' | 'rolled_back' | 'failed';
                    canary_percent: number;
                    error_message: string | null;
                    created_at: string;
                    updated_at: string;
                    completed_at: string | null;
                };
                Insert: {
                    id?: string;
                    deployment_id: string;
                    user_id: string;
                    new_customization_config: Json;
                    previous_state?: Json | null;
                    status?: 'pending' | 'validating' | 'generating' | 'updating_repo' | 'redeploying' | 'completed' | 'rolled_back' | 'failed';
                    canary_percent?: number;
                    error_message?: string | null;
                    created_at?: string;
                    updated_at?: string;
                    completed_at?: string | null;
                };
                Update: {
                    id?: string;
                    deployment_id?: string;
                    user_id?: string;
                    new_customization_config?: Json;
                    previous_state?: Json | null;
                    status?: 'pending' | 'validating' | 'generating' | 'updating_repo' | 'redeploying' | 'completed' | 'rolled_back' | 'failed';
                    canary_percent?: number;
                    error_message?: string | null;
                    created_at?: string;
                    updated_at?: string;
                    completed_at?: string | null;
                };
            };
            customization_drafts: {
                Row: {
                    id: string;
                    user_id: string;
                    template_id: string;
                    customization_config: Json;
                    created_at: string;
                    updated_at: string;
                };
                Insert: {
                    id?: string;
                    user_id: string;
                    template_id: string;
                    customization_config: Json;
                    created_at?: string;
                    updated_at?: string;
                };
                Update: {
                    id?: string;
                    user_id?: string;
                    template_id?: string;
                    customization_config?: Json;
                    created_at?: string;
                    updated_at?: string;
                };
            };
            error_reports: {
                Row: {
                    id: string;
                    user_id: string;
                    correlation_id: string | null;
                    description: string;
                    error_context: Json;
                    status: 'open' | 'investigating' | 'resolved';
                    created_at: string;
                };
                Insert: {
                    id?: string;
                    user_id: string;
                    correlation_id?: string | null;
                    description: string;
                    error_context: Json;
                    status?: 'open' | 'investigating' | 'resolved';
                    created_at?: string;
                };
                Update: {
                    id?: string;
                    user_id?: string;
                    correlation_id?: string | null;
                    description?: string;
                    error_context?: Json;
                    status?: 'open' | 'investigating' | 'resolved';
                    created_at?: string;
                };
            };
            deployment_analytics: {
                Row: {
                    id: string;
                    deployment_id: string;
                    metric_type: string;
                    metric_value: number;
                    recorded_at: string;
                };
                Insert: {
                    id?: string;
                    deployment_id: string;
                    metric_type: string;
                    metric_value: number;
                    recorded_at?: string;
                };
                Update: {
                    id?: string;
                    deployment_id?: string;
                    metric_type?: string;
                    metric_value?: number;
                    recorded_at?: string;
                };
            };
        };
    };
}
