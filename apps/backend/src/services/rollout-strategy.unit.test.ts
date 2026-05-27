/**
 * Unit Tests — Rollout Strategy Feature Flag Computation
 *
 * Issue #568 — test/issue-032-rollout-strategy-unit-tests
 *
 * Rollout Computation Algorithm (documented here per issue):
 * ──────────────────────────────────────────────────────────
 * RolloutEngine uses a deterministic counter-based routing algorithm:
 *
 *   useCanary = (requestCounter % 100) < canaryPercent
 *
 * This means:
 *   - At 0%  → no requests go to candidate (all stable)
 *   - At 50% → first 50 of every 100 requests go to candidate
 *   - At 100% → all requests go to candidate (promoted)
 *
 * Determinism: the same sequence of requests always produces the same
 * routing decisions for a given canaryPercent, because the counter is
 * monotonically incremented and the modulo is deterministic.
 *
 * Tier-based gating: BlueGreenSwitcher.switchToStandby() enforces health
 * thresholds (errorRate < 0.05, p99 ≤ 2000ms) before switching traffic.
 * This acts as a tier gate — only healthy candidates are promoted.
 *
 * Coverage:
 *   - Percentage-based rollout determinism (same inputs → same outputs)
 *   - Cohort boundary cases: 0%, 50%, 100%
 *   - Tier-based gating via BlueGreenSwitcher health checks
 *   - Rollback on threshold breach
 *   - Stable rollout decisions across repeated calls
 */

import { describe, it, expect } from 'vitest';
import {
    RolloutEngine,
    BlueGreenSwitcher,
    ROLLBACK_ERROR_RATE_THRESHOLD,
    ROLLBACK_LATENCY_THRESHOLD_MS,
    DEFAULT_CANARY_STEPS,
    type DeploymentVersion,
} from './rollout-strategy.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HEALTHY_STABLE: DeploymentVersion = {
    id: 'stable-v1',
    errorRate: 0.01,
    p99LatencyMs: 200,
};

const HEALTHY_CANDIDATE: DeploymentVersion = {
    id: 'candidate-v2',
    errorRate: 0.02,
    p99LatencyMs: 300,
};

const UNHEALTHY_CANDIDATE_ERROR: DeploymentVersion = {
    id: 'candidate-bad-error',
    errorRate: ROLLBACK_ERROR_RATE_THRESHOLD, // exactly at threshold → rollback
    p99LatencyMs: 100,
};

const UNHEALTHY_CANDIDATE_LATENCY: DeploymentVersion = {
    id: 'candidate-bad-latency',
    errorRate: 0.01,
    p99LatencyMs: ROLLBACK_LATENCY_THRESHOLD_MS + 1, // over threshold
};

// ── Percentage-based rollout determinism ──────────────────────────────────────

describe('RolloutEngine – percentage-based rollout determinism', () => {
    it('routes 0% to candidate at 0% canary', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(0);

        const counts = engine.simulateTraffic(100);

        expect(counts[HEALTHY_STABLE.id]).toBe(100);
        expect(counts[HEALTHY_CANDIDATE.id]).toBe(0);
    });

    it('routes exactly 50% to candidate at 50% canary', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(50);

        const counts = engine.simulateTraffic(100);

        expect(counts[HEALTHY_CANDIDATE.id]).toBe(50);
        expect(counts[HEALTHY_STABLE.id]).toBe(50);
    });

    it('routes 100% to candidate at 100% canary', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(100);

        const counts = engine.simulateTraffic(100);

        expect(counts[HEALTHY_CANDIDATE.id]).toBe(100);
        expect(counts[HEALTHY_STABLE.id]).toBe(0);
    });

    it('produces identical routing for the same request sequence (determinism)', () => {
        // Two engines with the same percent must produce the same routing sequence
        const engineA = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        const engineB = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engineA.setTrafficPercent(30);
        engineB.setTrafficPercent(30);

        const countsA = engineA.simulateTraffic(100);
        const countsB = engineB.simulateTraffic(100);

        expect(countsA).toEqual(countsB);
    });

    it('routing decisions are stable across repeated calls for the same percent', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(25);

        // Simulate 100 requests twice; second batch continues from counter=101
        const firstBatch = engine.simulateTraffic(100);
        const secondBatch = engine.simulateTraffic(100);

        // Both batches should route ~25% to candidate (counter-based, deterministic)
        expect(firstBatch[HEALTHY_CANDIDATE.id]).toBe(25);
        expect(secondBatch[HEALTHY_CANDIDATE.id]).toBe(25);
    });
});

// ── Cohort boundary cases ─────────────────────────────────────────────────────

describe('RolloutEngine – cohort boundary cases', () => {
    it('status is "pending" at 0%', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(0);
        expect(engine.status).toBe('pending');
    });

    it('status is "in_progress" at 50%', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(50);
        expect(engine.status).toBe('in_progress');
    });

    it('status is "promoted" at 100%', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(100);
        expect(engine.status).toBe('promoted');
    });

    it('throws RangeError for percent < 0', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        expect(() => engine.setTrafficPercent(-1)).toThrow(RangeError);
    });

    it('throws RangeError for percent > 100', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        expect(() => engine.setTrafficPercent(101)).toThrow(RangeError);
    });

    it('DEFAULT_CANARY_STEPS are [5, 25, 50]', () => {
        expect(DEFAULT_CANARY_STEPS).toEqual([5, 25, 50]);
    });

    it('each DEFAULT_CANARY_STEP routes the correct fraction', () => {
        for (const step of DEFAULT_CANARY_STEPS) {
            const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
            engine.setTrafficPercent(step);
            const counts = engine.simulateTraffic(100);
            expect(counts[HEALTHY_CANDIDATE.id]).toBe(step);
        }
    });
});

// ── Rollback on threshold breach ──────────────────────────────────────────────

describe('RolloutEngine – rollback on threshold breach', () => {
    it('triggers rollback when candidate error rate equals threshold', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, UNHEALTHY_CANDIDATE_ERROR);
        engine.setTrafficPercent(25);

        const didRollback = engine.evaluateAndMaybeRollback();

        expect(didRollback).toBe(true);
        expect(engine.status).toBe('rolled_back');
        expect(engine.canaryPercent).toBe(0);
    });

    it('triggers rollback when candidate p99 exceeds threshold', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, UNHEALTHY_CANDIDATE_LATENCY);
        engine.setTrafficPercent(50);

        const didRollback = engine.evaluateAndMaybeRollback();

        expect(didRollback).toBe(true);
        expect(engine.status).toBe('rolled_back');
    });

    it('does not rollback when candidate is healthy', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(50);

        const didRollback = engine.evaluateAndMaybeRollback();

        expect(didRollback).toBe(false);
        expect(engine.status).toBe('in_progress');
        expect(engine.canaryPercent).toBe(50);
    });

    it('after rollback, all traffic returns to stable', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, UNHEALTHY_CANDIDATE_ERROR);
        engine.setTrafficPercent(50);
        engine.evaluateAndMaybeRollback();

        const counts = engine.simulateTraffic(100);

        expect(counts[HEALTHY_STABLE.id]).toBe(100);
        expect(counts[UNHEALTHY_CANDIDATE_ERROR.id]).toBe(0);
    });

    it('promote() sets status to promoted and routes all traffic to candidate', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(50);
        engine.promote();

        expect(engine.status).toBe('promoted');
        expect(engine.canaryPercent).toBe(100);

        const counts = engine.simulateTraffic(100);
        expect(counts[HEALTHY_CANDIDATE.id]).toBe(100);
    });
});

// ── Tier-based gating (BlueGreenSwitcher) ────────────────────────────────────

describe('BlueGreenSwitcher – tier-based gating', () => {
    it('switches to standby when standby is healthy', () => {
        const switcher = new BlueGreenSwitcher(HEALTHY_STABLE, HEALTHY_CANDIDATE, 'blue');

        const switched = switcher.switchToStandby();

        expect(switched).toBe(true);
        expect(switcher.active).toBe('green');
        expect(switcher.standby).toBe('blue');
    });

    it('does not switch when standby error rate is at threshold', () => {
        const switcher = new BlueGreenSwitcher(HEALTHY_STABLE, UNHEALTHY_CANDIDATE_ERROR, 'blue');

        const switched = switcher.switchToStandby();

        expect(switched).toBe(false);
        expect(switcher.active).toBe('blue'); // unchanged
    });

    it('does not switch when standby p99 exceeds threshold', () => {
        const switcher = new BlueGreenSwitcher(HEALTHY_STABLE, UNHEALTHY_CANDIDATE_LATENCY, 'blue');

        const switched = switcher.switchToStandby();

        expect(switched).toBe(false);
        expect(switcher.active).toBe('blue');
    });

    it('activeVersion returns the correct deployment version', () => {
        const switcher = new BlueGreenSwitcher(HEALTHY_STABLE, HEALTHY_CANDIDATE, 'blue');

        expect(switcher.activeVersion()).toBe(HEALTHY_STABLE);
        expect(switcher.standbyVersion()).toBe(HEALTHY_CANDIDATE);
    });

    it('after successful switch, active and standby are swapped', () => {
        const switcher = new BlueGreenSwitcher(HEALTHY_STABLE, HEALTHY_CANDIDATE, 'blue');
        switcher.switchToStandby();

        expect(switcher.activeVersion()).toBe(HEALTHY_CANDIDATE);
        expect(switcher.standbyVersion()).toBe(HEALTHY_STABLE);
    });

    it('tier gating: candidate just below error threshold is allowed through', () => {
        const justBelowThreshold: DeploymentVersion = {
            id: 'candidate-just-ok',
            errorRate: ROLLBACK_ERROR_RATE_THRESHOLD - 0.001,
            p99LatencyMs: ROLLBACK_LATENCY_THRESHOLD_MS,
        };
        const switcher = new BlueGreenSwitcher(HEALTHY_STABLE, justBelowThreshold, 'blue');

        expect(switcher.switchToStandby()).toBe(true);
    });

    it('tier gating: candidate at exact latency threshold is allowed through', () => {
        const atLatencyThreshold: DeploymentVersion = {
            id: 'candidate-at-latency',
            errorRate: 0.01,
            p99LatencyMs: ROLLBACK_LATENCY_THRESHOLD_MS, // exactly at threshold → allowed (<=)
        };
        const switcher = new BlueGreenSwitcher(HEALTHY_STABLE, atLatencyThreshold, 'blue');

        expect(switcher.switchToStandby()).toBe(true);
    });
});

// ── Stable rollout decisions across repeated calls ────────────────────────────

describe('RolloutEngine – stable decisions across repeated calls', () => {
    it('canaryPercent is unchanged after multiple simulateTraffic calls', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(30);

        engine.simulateTraffic(1000);
        engine.simulateTraffic(1000);

        expect(engine.canaryPercent).toBe(30);
        expect(engine.status).toBe('in_progress');
    });

    it('routing ratio is consistent across large traffic volumes', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(10);

        const counts = engine.simulateTraffic(1000);

        // Counter-based: exactly 10% of every 100 requests → 100 out of 1000
        expect(counts[HEALTHY_CANDIDATE.id]).toBe(100);
        expect(counts[HEALTHY_STABLE.id]).toBe(900);
    });

    it('evaluateAndMaybeRollback is idempotent when candidate is healthy', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, HEALTHY_CANDIDATE);
        engine.setTrafficPercent(50);

        const first = engine.evaluateAndMaybeRollback();
        const second = engine.evaluateAndMaybeRollback();

        expect(first).toBe(false);
        expect(second).toBe(false);
        expect(engine.status).toBe('in_progress');
    });

    it('evaluateAndMaybeRollback is idempotent when candidate is unhealthy', () => {
        const engine = new RolloutEngine(HEALTHY_STABLE, UNHEALTHY_CANDIDATE_ERROR);
        engine.setTrafficPercent(50);

        engine.evaluateAndMaybeRollback();
        engine.evaluateAndMaybeRollback(); // second call should not change state

        expect(engine.status).toBe('rolled_back');
        expect(engine.canaryPercent).toBe(0);
    });
});
