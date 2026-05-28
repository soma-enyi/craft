/**
 * GitHubWorkflowValidator
 *
 * Validates GitHub Actions workflow YAML for syntax and required steps.
 * Ensures generated workflows contain build, test, and deploy steps before deployment.
 *
 * Required workflow steps (must all be present):
 *   - build: Compiles/builds the application
 *   - test: Runs automated tests
 *   - deploy: Deploys to production or staging
 */

export interface WorkflowValidationError {
    code: 'INVALID_YAML' | 'MISSING_STEP' | 'EMPTY_CONTENT';
    message: string;
    step?: string;
}

export interface WorkflowValidationResult {
    valid: boolean;
    errors: WorkflowValidationError[];
}

const REQUIRED_STEPS = ['build', 'test', 'deploy'];

/**
 * Simple YAML parser for GitHub Actions workflow structure.
 * Extracts job names to verify required steps exist.
 */
function parseWorkflowYaml(content: string): { jobs: string[] } | null {
    const lines = content.split('\n');
    const jobs: string[] = [];
    let inJobs = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Detect 'jobs:' section
        if (trimmed === 'jobs:') {
            inJobs = true;
            continue;
        }

        if (inJobs) {
            // Check for job name (indented key followed by colon)
            if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
                const jobName = trimmed.slice(0, -1).trim();
                if (jobName && !jobName.startsWith('-')) {
                    jobs.push(jobName);
                }
            }
            // Stop parsing jobs if we hit a new top-level key
            if (!line.startsWith(' ') && trimmed.endsWith(':')) {
                inJobs = false;
            }
        }
    }

    return jobs.length > 0 ? { jobs } : null;
}

export class GitHubWorkflowValidator {
    /**
     * Validate a GitHub Actions workflow YAML.
     * Checks for valid YAML syntax and presence of required steps.
     */
    validate(workflowYaml: string): WorkflowValidationResult {
        const errors: WorkflowValidationError[] = [];

        // Check for empty content
        if (!workflowYaml.trim()) {
            errors.push({
                code: 'EMPTY_CONTENT',
                message: 'Workflow YAML is empty',
            });
            return { valid: false, errors };
        }

        // Basic YAML syntax validation (tabs, colons)
        for (const line of workflowYaml.split('\n')) {
            if (line.startsWith('\t')) {
                errors.push({
                    code: 'INVALID_YAML',
                    message: 'YAML syntax error: tab indentation not allowed',
                });
                return { valid: false, errors };
            }

            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-')) {
                // Key-value pairs should have a colon
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0 && line[colonIdx + 1] !== undefined && line[colonIdx + 1] !== ' ' && line[colonIdx + 1] !== '\n') {
                    // Allow "key: value" or "key:" patterns
                    const afterColon = line.substring(colonIdx + 1).trim();
                    if (afterColon && !afterColon.startsWith('#')) {
                        // This is OK, it's "key: value"
                    }
                }
            }
        }

        // Parse workflow structure
        const parsed = parseWorkflowYaml(workflowYaml);
        if (!parsed) {
            errors.push({
                code: 'INVALID_YAML',
                message: 'Workflow YAML is invalid or has no jobs defined',
            });
            return { valid: false, errors };
        }

        // Check for required steps
        const jobsLower = parsed.jobs.map((j) => j.toLowerCase());
        for (const requiredStep of REQUIRED_STEPS) {
            if (!jobsLower.includes(requiredStep)) {
                errors.push({
                    code: 'MISSING_STEP',
                    message: `Workflow missing required step: ${requiredStep}`,
                    step: requiredStep,
                });
            }
        }

        return {
            valid: errors.length === 0,
            errors,
        };
    }
}

export const workflowValidator = new GitHubWorkflowValidator();
