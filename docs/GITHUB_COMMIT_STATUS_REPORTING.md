# GitHub Commit Status Reporting

**Issue:** #651  
**Branch:** `feat/issue-115-github-commit-status-reporting`

---

## Overview

CRAFT's deployment pipeline now posts GitHub [commit statuses](https://docs.github.com/en/rest/commits/statuses) at each key transition point. This gives developers live feedback directly in pull-request and commit views on GitHub — no need to leave GitHub to check deployment progress.

When a deployment is triggered, a status badge appears next to the associated commit. The badge links directly to the deployment detail page in CRAFT so developers can dig into logs and metadata with a single click.

---

## Status Lifecycle

| Pipeline Event | GitHub Status State | Description |
|---|---|---|
| Code pushed to repository (SHA known) | `pending` | `Deployment is in progress…` |
| Deployment completed successfully | `success` | `Deployed to <deploymentUrl>` |
| Any stage fails | `failure` | `Deployment failed at stage: <stageName>` |

### Sequencing Notes

- The commit SHA is not available until the generated code is pushed to the GitHub repository (Step 4 of the pipeline). For this reason, the `pending` status is posted **immediately after a successful push**, not at the very start of the pipeline.
- `success` is posted only after the Vercel deployment URL is confirmed and the deployment record is written to the database as `completed`.
- Stages that fail **before** the push step (e.g., `generating`, `validating`, `signing`, `creating_repo`) do not emit a status because no commit SHA exists yet.

---

## Failure Policy — Non-Blocking by Design

Status reporting failures **must never block or abort the deployment pipeline**.

All calls to `GitHubCommitStatusService` are wrapped in `DeploymentPipelineService.reportCommitStatus()`, which:

1. Catches any exception thrown by the status service.
2. Writes a `warn`-level entry to `deployment_logs` (stage: `commit_status`).
3. Returns control to the pipeline, which continues normally.

This means a misconfigured `GITHUB_TOKEN`, a GitHub API outage, or a network hiccup will degrade status reporting but will **not** prevent deployments from completing.

---

## Configuration

| Environment Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | Yes | — | Personal Access Token or GitHub App installation token. Must have the `repo:status` scope (or `public_repo:status` for public repositories). |
| `NEXT_PUBLIC_APP_URL` | Yes | — | Base URL of the CRAFT application (e.g. `https://craft.app`). Used to build the `target_url` that each status badge links to. |
| `GITHUB_COMMIT_STATUS_CONTEXT` | No | `craft/deployment` | The status context label shown in GitHub UI. Changing this groups statuses under a different check name. |

### Token Permissions

The `GITHUB_TOKEN` used by the deployment pipeline needs at minimum:

- `repo:status` — to create commit statuses on **private** repositories.
- `public_repo:status` — to create commit statuses on **public** repositories only.

If you use a GitHub App installation token (recommended), ensure the app has **Commit statuses: Read and write** under the repository permissions.

---

## Architecture

### New Service — `GitHubCommitStatusService`

**Location:** `apps/backend/src/services/github-commit-status.service.ts`

```
GitHubCommitStatusService
  ├── postCommitStatus(request)       ← core method; never throws
  ├── reportPending(owner, repo, sha, deploymentId, stageName?)
  ├── reportSuccess(owner, repo, sha, deploymentId, deploymentUrl?)
  └── reportFailure(owner, repo, sha, deploymentId, failedStage?)

buildDeploymentDetailUrl(deploymentId, appUrl?)  ← pure helper; exported for tests
```

The service receives a `FetchLike` constructor argument, making it fully testable without network calls.

### Integration in `DeploymentPipelineService`

**Location:** `apps/backend/src/services/deployment-pipeline.service.ts`

The service is injected as an optional constructor parameter:

```typescript
constructor(
  // …existing parameters…
  private readonly _commitStatusService: Pick<
    GitHubCommitStatusService,
    'reportPending' | 'reportSuccess' | 'reportFailure'
  > = githubCommitStatusService,
)
```

The integration points inside `deploy()`:

| Location in `deploy()` | What happens |
|---|---|
| After `pushGeneratedCode` succeeds | `reportPending` is called with the new commit SHA |
| After `deployments` record is updated to `completed` | `reportSuccess` is called |
| Inside the `fail()` private helper (when `commitContext` is set) | `reportFailure` is called (currently unused for pre-push failures — no SHA available) |

All three calls go through `reportCommitStatus()`, which wraps them in `try/catch` and logs a `warn`-level entry on failure.

---

## Testing

### `github-commit-status.service.test.ts`

Full unit test coverage for the standalone service:

- `postCommitStatus` — happy path for each state (`pending`, `success`, `failure`, `error`).
- Missing `GITHUB_TOKEN` → returns failure, no fetch call.
- GitHub API non-ok response → returns failure with error message.
- Network error (fetch throws) → returns failure without re-throwing.
- Description truncation to 140 characters.
- `target_url` omitted when `targetUrl` is not provided.
- Correct endpoint URL, Authorization header, and API version header.
- `buildDeploymentDetailUrl` unit tests.

### `deployment-pipeline.service.test.ts`

New test suite **"GitHub commit status reporting (#651)"** appended to the existing file:

| Test | What it asserts |
|---|---|
| Reports pending after code push | `reportPending` called once on success |
| Reports success after completion | `reportSuccess` called once; `reportFailure` not called |
| SHA from push result passed to reportPending | Correct `commitSha` forwarded |
| No status when pipeline fails before push | None of the three methods called |
| No success when Vercel fails | `reportSuccess` not called |
| Failure result from reportPending does not block pipeline | Full deployment still succeeds |
| reportSuccess throwing does not block pipeline | Full deployment still succeeds |
| reportPending throwing does not block pipeline | Full deployment still succeeds |
| Warn log written on failure result | `commit_status` warn log entry present |
| Warn log written on unexpected throw | `commit_status` warn log entry present |

### Running the Tests

```bash
# Run all tests in the backend app
cd apps/backend
npx vitest run

# Run only the new service tests
npx vitest run src/services/github-commit-status.service.test.ts

# Run the pipeline tests (includes the new #651 suite)
npx vitest run src/services/deployment-pipeline.service.test.ts
```

---

## GitHub UI — What Developers See

Once deployed and configured, developers will see a status section in each pull request and on each commit page on GitHub:

```
○  craft/deployment   Details   Deployment is in progress…
↓  (after completion)
✓  craft/deployment   Details   Deployed to https://my-app.vercel.app
```

Clicking **Details** opens the CRAFT deployment detail page at:

```
https://<NEXT_PUBLIC_APP_URL>/app/deployments/<deploymentId>
```

---

## Extending This Feature

### Adding per-stage statuses

The current implementation posts a single `craft/deployment` status. You can post per-stage statuses by calling `postCommitStatus` directly with a more specific `context` value:

```typescript
await this._commitStatusService.postCommitStatus({
    owner,
    repo,
    sha,
    state: 'pending',
    context: 'craft/deployment — code-generation',
    description: 'Generating code from template…',
    targetUrl: buildDeploymentDetailUrl(deploymentId),
});
```

GitHub groups statuses by `context`, so each distinct value appears as a separate check.

### Custom context label

Set `GITHUB_COMMIT_STATUS_CONTEXT` in your environment to change the label shown in GitHub UI. This is useful when running multiple CRAFT instances (e.g., staging vs. production) that target the same repositories.

---

## Related Documents

- [`docs/github-vercel-deployment-triggering.md`](./github-vercel-deployment-triggering.md) — describes the Vercel deployment trigger flow.
- [`docs/deployment-detail-design.md`](./deployment-detail-design.md) — the deployment detail page that `target_url` links to.
- [GitHub Statuses API reference](https://docs.github.com/en/rest/commits/statuses)
