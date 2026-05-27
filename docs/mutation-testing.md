# Mutation Testing Guide

## Overview

Mutation testing is a technique to verify the quality and effectiveness of test suites by introducing deliberate bugs (mutations) into the code and checking if tests catch them. This document describes the mutation testing setup for CRAFT's core service layer.

## Setup

### Installation

```bash
npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker
```

### Configuration

The mutation testing configuration is defined in `stryker.conf.json` at the project root.

**Key Configuration (Issue #586):**
- **Mutate**: All core services in `apps/backend/src/services/**/*.ts` (test/fixture/helper files excluded)
- **Test Runner**: Vitest
- **Test Pattern**: All `*.test.ts`, `*.integration.test.ts`, and `*.property.test.ts` files under `apps/backend/src/services/`
- **Reporters**: HTML, JSON, and clear-text output
- **Global Threshold**: 80% (high), 70% (medium), 60% (low) — enforces 80% across all core services
- **Per-File Threshold**: 80% high / 70% medium / 60% low applied individually to every service file
- **Timeout**: 5 seconds per test with 1.25x factor

**Glob exclusions (never mutated):**
- `*.test.ts`, `*.property.test.ts`, `*.integration.test.ts`, `*.snapshot.test.ts`
- `*.helpers.ts`
- `__fixtures__/**`

## Running Mutation Tests

### Full Mutation Test Suite

```bash
npx stryker run
```

### Dry Run (Preview mutations without running tests)

```bash
npx stryker run --dryRun
```

### Incremental Testing

```bash
npx stryker run --incremental
```

## Understanding Results

### Mutation Score

The mutation score indicates the percentage of mutations killed (caught) by tests:

- **Killed**: Test caught the mutation (good)
- **Survived**: Test missed the mutation (bad - indicates weak test)
- **Timeout**: Mutation caused infinite loop
- **Compile Error**: Mutation caused syntax error

### Example Output

```
Mutation score: 85.5%
Killed: 171
Survived: 29
Timeout: 2
Compile errors: 0
```

## Mutation Score Thresholds

### Global Thresholds

Applied to the aggregated score across all mutated service files:

| Level | Score |
| --- | --- |
| High | 80% |
| Medium | 70% |
| Low | 60% |

### Per-File Thresholds — Core Services (Issue #586)

All core services now share a uniform 80% high / 70% medium / 60% low threshold:

| Service | High | Medium | Low | Notes |
| --- | --- | --- | --- | --- |
| auth.service.ts | 80% | 70% | 60% | Authentication and authorization |
| payment.service.ts | 80% | 70% | 60% | Payment processing and billing |
| deployment-pipeline.service.ts | 80% | 70% | 60% | Core deployment orchestration |
| deployment-update.service.ts | 80% | 70% | 60% | Deployment record updates |
| deployment.service.ts | 80% | 70% | 60% | Deployment CRUD |
| vercel.service.ts | 80% | 70% | 60% | Vercel API client |
| github.service.ts | 80% | 70% | 60% | GitHub API client |
| github-push.service.ts | 80% | 70% | 60% | Code push logic |
| stellar-network.service.ts | 80% | 70% | 60% | Stellar network integration |
| template.service.ts | 80% | 70% | 60% | Template management |
| preview.service.ts | 80% | 70% | 60% | Preview generation |
| customization-draft.service.ts | 80% | 70% | 60% | Draft CRUD |
| health-monitor.service.ts | 80% | 70% | 60% | Health checks |
| analytics.service.ts | 80% | 70% | 60% | Usage analytics |
| code-generator.service.ts | 80% | 70% | 60% | Code generation |
| template-generator.service.ts | 80% | 70% | 60% | Template scaffolding |
| template-cloning.service.ts | 80% | 70% | 60% | Template cloning |
| github-credential.service.ts | 80% | 70% | 60% | GitHub credential management |
| stellar-account-validator.service.ts | 80% | 70% | 60% | Stellar account validation |
| stellar-asset-validator.service.ts | 80% | 70% | 60% | Stellar asset validation |
| soroban-contract-validator.service.ts | 80% | 70% | 60% | Soroban contract validation |
| error-report.service.ts | 80% | 70% | 60% | Error reporting |
| artifact-signing.service.ts | 80% | 70% | 60% | Artifact signing |
| config-validator.service.ts | 80% | 70% | 60% | Config validation |
| syntax-validator.ts | 80% | 70% | 60% | Syntax validation |
| package-json-validator.service.ts | 80% | 70% | 60% | package.json validation |
| deployment-logs.service.ts | 80% | 70% | 60% | Deployment log persistence |
| github-app-auth.service.ts | 80% | 70% | 60% | GitHub App auth |
| github-to-vercel-deployment.service.ts | 80% | 70% | 60% | GitHub→Vercel pipeline |
| rollout-strategy.service.ts | 80% | 70% | 60% | Rollout orchestration |

### Threshold Rationale

**80% uniform threshold for all core services:**
- All services in the core layer are production-critical paths
- Uniform threshold eliminates ambiguity about which files require stricter coverage
- 80% allows intentionally ignored mutants (see Acceptable Survivors section) while enforcing
  meaningful test sensitivity for every service

## Achieved Scores (Issue #586)

| Service | Score | Status |
| --- | --- | --- |
| auth.service.ts | 80%+ | ✅ |
| payment.service.ts | 80%+ | ✅ |
| deployment-pipeline.service.ts | 80%+ | ✅ (baseline achieved in Issue #537) |
| vercel.service.ts | 80%+ | ✅ |
| github.service.ts | 80%+ | ✅ |
| stellar-network.service.ts | 80%+ | ✅ |
| template.service.ts | 80%+ | ✅ |
| preview.service.ts | 80%+ | ✅ |
| All other core services | 80%+ | ✅ |

All services covered by the extended glob pattern in `stryker.conf.json` target 80% high.

## Critical Services

### 1. Auth Service (`auth.service.ts`)

**Target Score**: 80%+

**Key Mutations to Catch:**
- Error handling in signup/signin
- Session token validation
- Profile creation failures
- JWT expiry checks
- RLS policy enforcement

**Tests**: `auth.service.test.ts`, `auth.integration.test.ts`

### 2. Payment Service (`payment.service.ts`)

**Target Score**: 80%+

**Key Mutations to Catch:**
- Subscription tier validation
- Payment status transitions
- Refund logic
- Stripe API error handling
- Billing cycle calculations

**Tests**: `payment.service.test.ts`

### 3. Deployment Pipeline Service (`deployment-pipeline.service.ts`)

**Target Score**: 75%+

**Baseline Score (Issue #537)**: 80%+ achieved

**Key Mutations to Catch:**
- Deployment status progression (pending → generating → validating → signing → creating_repo → pushing_code → deploying → verifying_contract → completed/failed)
- Invalid state transitions (e.g., pending → completed should fail)
- GitHub/Vercel API calls
- Rollback logic on failure
- Rate limit handling
- Database transaction management
- Syntax validation hook
- Artifact signing and verification
- Circular dependency detection

**Tests**: `deployment-pipeline.service.test.ts`, `tests/deployment/**/*.test.ts`

### 4. Deployment Queue Service (`deployment-queue.service.ts`)

**Target Score**: 75%+

**Key Mutations to Catch:**
- Queue ordering and prioritization
- Concurrent deployment handling
- Queue state transitions
- Timeout and retry logic

**Tests**: `tests/queue/deployment-queue.test.ts`

### 5. Deployment Monitor Service (`deployment-monitor.service.ts`)

**Target Score**: 75%+

**Key Mutations to Catch:**
- Health check logic
- Alert triggering conditions
- Metric collection and aggregation
- Threshold comparisons

**Tests**: `tests/monitoring/alerting.test.ts`

### 6. Deployment Rollback Service (`deployment-rollback.service.ts`)

**Target Score**: 75%+

**Key Mutations to Catch:**
- Rollback state validation
- Previous version restoration
- Cleanup operations
- Error recovery

**Tests**: `tests/deployment/rollback.test.ts`

**Boundary-Value Tests Added (Issue #537):**
- All invalid state transitions are rejected
- Terminal states (completed, failed) have no outgoing transitions
- Non-terminal states have at least one valid transition
- All states are reachable from pending
- No cycles in state transition graph
- Status persistence on every update
- Error logging at each failure point
- Rollback integration with DeploymentUpdateService
- Syntax validation between generation and repo creation
- Artifact verification before push

## Improving Mutation Score

### 1. Identify Surviving Mutants

Review the HTML report at `mutation-test-results/index.html` to see which mutations survived.

### 2. Add Missing Tests

For each surviving mutant, add a test that would catch it:

```typescript
// Example: Test for boundary condition
it('should reject invalid subscription tier', () => {
  expect(() => validateTier('invalid')).toThrow();
});
```

### 3. Strengthen Assertions

Ensure tests verify both positive and negative cases:

```typescript
// Weak test
expect(result).toBeDefined();

// Strong test
expect(result).toBeDefined();
expect(result.status).toBe('success');
expect(result.data).toEqual(expectedData);
```

### 4. Test Edge Cases

Add tests for boundary conditions and error scenarios:

```typescript
it('should handle null values', () => {
  expect(service.process(null)).toThrow();
});

it('should handle empty arrays', () => {
  expect(service.process([])).toEqual([]);
});
```

## Acceptable Survivors

Some mutations may be acceptable survivors if they represent:

1. **Cosmetic changes** (e.g., variable naming)
2. **Unreachable code** (e.g., after throw statements)
3. **Defensive programming** (e.g., redundant null checks)

Document these in the mutation report with explanations.

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Run mutation tests
  run: npx stryker run
  
- name: Check mutation score thresholds
  run: |
    SCORE=$(jq '.score' mutation-test-results/mutation.json)
    if (( $(echo "$SCORE < 75" | bc -l) )); then
      echo "Mutation score $SCORE is below 75% threshold"
      exit 1
    fi
  
- name: Upload mutation report
  uses: actions/upload-artifact@v2
  with:
    name: mutation-report
    path: mutation-test-results/
```

### Fail on Low Score

```bash
npx stryker run --thresholds.high=75 --thresholds.medium=65
```

## Performance Considerations

- Mutation testing is slower than unit testing (5-10x slower)
- Run on CI/CD, not on every local test
- Use incremental mode for faster iterations
- Consider running only on critical services

## Troubleshooting

### Tests Timeout

Increase `timeoutMS` in `stryker.conf.json`:

```json
{
  "timeoutMS": 10000,
  "timeoutFactor": 1.5
}
```

### Out of Memory

Reduce `maxConcurrentTestRunners`:

```json
{
  "maxConcurrentTestRunners": 2
}
```

### Stale Results

Clear incremental cache:

```bash
rm .stryker-incremental.json
npx stryker run
```

## Resources

- [Stryker Documentation](https://stryker-mutator.io/)
- [Mutation Testing Best Practices](https://stryker-mutator.io/docs/mutation-testing-elements/mutation-operators/)
- [Vitest Integration](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)

## Maintenance

- Review mutation scores quarterly
- Update tests when new features are added
- Monitor for performance regressions
- Keep Stryker and dependencies updated
- Adjust per-file thresholds as services mature
