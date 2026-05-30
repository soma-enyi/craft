/**
 * GitHub OAuth scope validation for deployment operations.
 *
 * Validates that a GitHub access token grants all scopes required for CRAFT
 * deployment operations before any repository work is attempted.
 *
 * Required scopes
 * ───────────────
 * repo       — Full read/write access to public and private repositories.
 *              Required to create repos, push code, and configure webhooks.
 * read:user  — Read the authenticated user's profile data (login, email).
 *              Required during OAuth callback to persist the GitHub username.
 *
 * GitHub returns the granted scopes in the `X-OAuth-Scopes` response header on
 * any authenticated API call. This module inspects that header and compares it
 * against the required scope list.
 *
 * Scope hierarchy
 * ───────────────
 * GitHub scopes are hierarchical: `repo` covers `public_repo`, `repo:status`,
 * `repo:deployment`, etc. The validator resolves this — if `repo` is granted,
 * narrower `repo:*` sub-scopes are satisfied automatically.
 *
 * Feature: github-oauth-scope-validation
 * Issue: #658
 */

const GITHUB_USER_URL = 'https://api.github.com/user';

/** All scopes CRAFT requires for deployment operations. */
export const REQUIRED_SCOPES = ['repo', 'read:user'] as const;

export type RequiredScope = (typeof REQUIRED_SCOPES)[number];

export interface ScopeValidationResult {
    valid: boolean;
    grantedScopes: string[];
    missingScopes: RequiredScope[];
}

/**
 * Broad-scope parents that implicitly satisfy narrower child scopes.
 * e.g. "repo" satisfies "public_repo", "repo:status", "repo:deployment".
 */
const SCOPE_PARENTS: Record<string, string> = {
    'public_repo': 'repo',
    'repo:status': 'repo',
    'repo:deployment': 'repo',
    'repo:invite': 'repo',
    'repo:hooks': 'repo',
    'read:user': 'user',
    'user:email': 'user',
    'user:follow': 'user',
};

/**
 * Returns true if `granted` satisfies `required`, accounting for scope
 * hierarchy (a parent scope satisfies all its children).
 */
function scopeSatisfied(required: string, granted: Set<string>): boolean {
    if (granted.has(required)) return true;
    const parent = SCOPE_PARENTS[required];
    return parent !== undefined && granted.has(parent);
}

/**
 * Parse the comma-separated `X-OAuth-Scopes` header value into an array.
 * Returns an empty array when the header is absent or empty.
 */
export function parseGrantedScopes(header: string | null): string[] {
    if (!header) return [];
    return header.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Validate that `grantedScopes` covers all REQUIRED_SCOPES.
 */
export function validateScopes(grantedScopes: string[]): ScopeValidationResult {
    const granted = new Set(grantedScopes);
    const missingScopes = REQUIRED_SCOPES.filter(
        (s) => !scopeSatisfied(s, granted),
    ) as RequiredScope[];

    return {
        valid: missingScopes.length === 0,
        grantedScopes,
        missingScopes,
    };
}

/**
 * Fetch the X-OAuth-Scopes header from GitHub by making an authenticated
 * request to GET /user and reading the response headers.
 *
 * Returns a ScopeValidationResult. Never throws — all error paths return
 * { valid: false } so callers can surface actionable messages.
 */
export async function fetchAndValidateScopes(
    accessToken: string,
): Promise<ScopeValidationResult & { fetchError?: string }> {
    let res: Response;
    try {
        res = await fetch(GITHUB_USER_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Network error';
        return {
            valid: false,
            grantedScopes: [],
            missingScopes: [...REQUIRED_SCOPES],
            fetchError: message,
        };
    }

    if (!res.ok) {
        return {
            valid: false,
            grantedScopes: [],
            missingScopes: [...REQUIRED_SCOPES],
            fetchError: `GitHub API returned ${res.status}`,
        };
    }

    const scopeHeader = res.headers.get('X-OAuth-Scopes');
    const grantedScopes = parseGrantedScopes(scopeHeader);
    return validateScopes(grantedScopes);
}

/**
 * Build a human-readable error message listing the missing scopes.
 * Used to surface re-authorization instructions to the user.
 */
export function buildMissingScopeMessage(missingScopes: RequiredScope[]): string {
    const list = missingScopes.map((s) => `\`${s}\``).join(', ');
    return (
        `The GitHub token is missing required scopes: ${list}. ` +
        'Please disconnect and reconnect your GitHub account to grant the required permissions.'
    );
}
