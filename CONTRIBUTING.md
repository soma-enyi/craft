# Contributing

This repository uses a monorepo layout (`apps/*`, `packages/*`) with tests and linting enforced before merge.

## General Workflow

1. Create a focused branch for your issue.
2. Keep changes scoped and reviewable.
3. Add or update tests with behavior changes.
4. Run checks locally before opening a PR:

```bash
npm run test
npm run lint
npm run build
```

5. Link the PR to the relevant issue.

## Snapshot Testing (Stellar Configuration)

Snapshot tests capture and diff configuration outputs to catch unintended changes in network settings, RPC endpoints, and serialization.

### Snapshot Files

Snapshots are stored in `__snapshots__` directories co-located with test files:

- `packages/stellar/src/__snapshots__/config.test.ts.snap`
- `apps/frontend/src/lib/stellar/__snapshots__/stellar-config-generator.test.ts.snap`

### Update Snapshots

When intentional changes are made to Stellar configuration (e.g., updating RPC endpoints, changing network passphrases), update snapshots:

```bash
npm run test -- --update-snapshots
```

Or for a specific test file:

```bash
npm run test -- packages/stellar/src/config.test.ts --update-snapshots
npm run test -- apps/frontend/src/lib/stellar/stellar-config-generator.test.ts --update-snapshots
```

### Snapshot Review

Always review snapshot diffs in your PR:

1. Run tests to see which snapshots changed
2. Verify the changes are intentional
3. Commit the updated snapshot files
4. Include a note in the PR description explaining why snapshots were updated

### When to Update Snapshots

- ✅ Intentional changes to network configuration (e.g., new RPC endpoint)
- ✅ Changes to environment variable serialization format
- ✅ Updates to generated file templates
- ❌ Do NOT update snapshots to hide unintended changes — investigate and fix the root cause

## Visual Regression Baselines (Deployment Preview)

Visual regression baselines for deployment preview templates are stored in:

- `apps/backend/tests/visual/baselines/deployment-preview/dex.baseline.json`
- `apps/backend/tests/visual/baselines/deployment-preview/defi.baseline.json`
- `apps/backend/tests/visual/baselines/deployment-preview/payment.baseline.json`
- `apps/backend/tests/visual/baselines/deployment-preview/asset.baseline.json`

### Compare Baselines

Run this in default mode to validate that generated screenshots remain within the allowed diff threshold:

```bash
npm run --workspace @craft/backend test -- tests/visual/preview.visual.test.ts
```

CI runs the same compare path in `.github/workflows/visual-regression.yml`. Any diff over threshold fails the job.

### Update Baselines

When intentional visual changes are made to deployment preview templates, regenerate and commit updated baselines:

```bash
VISUAL_BASELINE_MODE=store npm run --workspace @craft/backend test -- tests/visual/preview.visual.test.ts
```

On Windows PowerShell:

```powershell
$env:VISUAL_BASELINE_MODE='store'
npm run --workspace @craft/backend test -- tests/visual/preview.visual.test.ts
Remove-Item Env:VISUAL_BASELINE_MODE
```

### PR Expectations

1. Include before/after screenshots for each affected template category (`dex`, `defi`, `payment`, `asset`).
2. Keep baseline-only updates in small, reviewable commits.
3. Ensure baseline-missing failures are not bypassed; tests should fail with a clear missing-baseline message.
