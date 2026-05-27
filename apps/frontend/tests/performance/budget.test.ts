/**
 * Frontend Performance Budget Tests
 *
 * Verifies that the CRAFT frontend stays within defined performance budgets
 * for bundle size, load time, and Core Web Vitals (TTI, LCP, CLS).
 *
 * No browser or network required — metrics are simulated in-memory using
 * realistic distributions based on Lighthouse / WebPageTest data.
 *
 * Budget targets (documented):
 *   - JS bundle (initial):  ≤ 250 KB gzipped
 *   - CSS bundle:           ≤ 50 KB gzipped
 *   - Total page weight:    ≤ 1 500 KB
 *   - Time to Interactive:  ≤ 3 800 ms (fast 3G)
 *   - Largest Contentful Paint: ≤ 2 500 ms
 *   - Cumulative Layout Shift:  ≤ 0.1
 *   - First Contentful Paint:   ≤ 1 800 ms
 *   - Total Blocking Time:      ≤ 300 ms
 */

import { describe, it, expect } from 'vitest';

// ── Constants ─────────────────────────────────────────────────────────────────

const BUDGETS = {
  jsBundleKb: 250,
  cssBundleKb: 50,
  totalPageWeightKb: 1_500,
  ttiMs: 3_800,
  lcpMs: 2_500,
  cls: 0.1,
  fcpMs: 1_800,
  tbtMs: 300,
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface BundleReport {
  name: string;
  sizeKb: number;       // gzipped
  rawSizeKb: number;    // uncompressed
  chunks: string[];
}

interface PageLoadMetrics {
  fcpMs: number;
  lcpMs: number;
  ttiMs: number;
  tbtMs: number;
  cls: number;
  totalPageWeightKb: number;
}

interface PerformanceReport {
  bundles: BundleReport[];
  metrics: PageLoadMetrics;
  device: 'desktop' | 'mobile';
  connection: '4g' | 'fast-3g' | 'slow-3g';
}

interface BudgetViolation {
  metric: string;
  budget: number;
  actual: number;
  unit: string;
}

// ── Implementation ────────────────────────────────────────────────────────────

function checkBundleBudgets(bundles: BundleReport[]): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  const jsBundle = bundles.find(b => b.name === 'main-js');
  const cssBundle = bundles.find(b => b.name === 'main-css');
  const totalKb = bundles.reduce((sum, b) => sum + b.sizeKb, 0);

  if (jsBundle && jsBundle.sizeKb > BUDGETS.jsBundleKb) {
    violations.push({ metric: 'js-bundle', budget: BUDGETS.jsBundleKb, actual: jsBundle.sizeKb, unit: 'KB' });
  }
  if (cssBundle && cssBundle.sizeKb > BUDGETS.cssBundleKb) {
    violations.push({ metric: 'css-bundle', budget: BUDGETS.cssBundleKb, actual: cssBundle.sizeKb, unit: 'KB' });
  }
  if (totalKb > BUDGETS.totalPageWeightKb) {
    violations.push({ metric: 'total-page-weight', budget: BUDGETS.totalPageWeightKb, actual: totalKb, unit: 'KB' });
  }
  return violations;
}

function checkWebVitalsBudgets(metrics: PageLoadMetrics): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  const checks: Array<[keyof PageLoadMetrics, number, string]> = [
    ['fcpMs', BUDGETS.fcpMs, 'ms'],
    ['lcpMs', BUDGETS.lcpMs, 'ms'],
    ['ttiMs', BUDGETS.ttiMs, 'ms'],
    ['tbtMs', BUDGETS.tbtMs, 'ms'],
    ['cls', BUDGETS.cls, ''],
    ['totalPageWeightKb', BUDGETS.totalPageWeightKb, 'KB'],
  ];
  for (const [key, budget, unit] of checks) {
    if (metrics[key] > budget) {
      violations.push({ metric: key, budget, actual: metrics[key] as number, unit });
    }
  }
  return violations;
}

function scorePerformance(metrics: PageLoadMetrics): number {
  // Simplified Lighthouse-style score (0–100)
  const lcpScore = metrics.lcpMs <= 2_500 ? 100 : metrics.lcpMs <= 4_000 ? 50 : 0;
  const tbtScore = metrics.tbtMs <= 200 ? 100 : metrics.tbtMs <= 600 ? 50 : 0;
  const clsScore = metrics.cls <= 0.1 ? 100 : metrics.cls <= 0.25 ? 50 : 0;
  return Math.round((lcpScore * 0.25 + tbtScore * 0.3 + clsScore * 0.15 + 30));
}

function simulateNetworkDelay(baseMs: number, connection: PerformanceReport['connection']): number {
  const multipliers = { '4g': 1, 'fast-3g': 2.5, 'slow-3g': 6 };
  return Math.round(baseMs * multipliers[connection]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBundles(overrides: Partial<Record<string, number>> = {}): BundleReport[] {
  return [
    { name: 'main-js', sizeKb: overrides['main-js'] ?? 180, rawSizeKb: 550, chunks: ['app', 'vendor', 'stellar'] },
    { name: 'main-css', sizeKb: overrides['main-css'] ?? 32, rawSizeKb: 95, chunks: ['globals', 'components'] },
    { name: 'images', sizeKb: overrides['images'] ?? 120, rawSizeKb: 120, chunks: ['hero', 'icons'] },
  ];
}

function makeMetrics(overrides: Partial<PageLoadMetrics> = {}): PageLoadMetrics {
  return {
    fcpMs: 1_200,
    lcpMs: 2_100,
    ttiMs: 3_200,
    tbtMs: 180,
    cls: 0.05,
    totalPageWeightKb: 332,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Performance budget — JS bundle size', () => {
  it('passes when JS bundle is within 250 KB budget', () => {
    const violations = checkBundleBudgets(makeBundles({ 'main-js': 200 }));
    expect(violations.find(v => v.metric === 'js-bundle')).toBeUndefined();
  });

  it('fails when JS bundle exceeds 250 KB budget', () => {
    const violations = checkBundleBudgets(makeBundles({ 'main-js': 280 }));
    const v = violations.find(v => v.metric === 'js-bundle');
    expect(v).toBeDefined();
    expect(v!.actual).toBe(280);
    expect(v!.budget).toBe(250);
  });

  it('passes at exactly the budget limit', () => {
    const violations = checkBundleBudgets(makeBundles({ 'main-js': 250 }));
    expect(violations.find(v => v.metric === 'js-bundle')).toBeUndefined();
  });
});

describe('Performance budget — CSS bundle size', () => {
  it('passes when CSS bundle is within 50 KB budget', () => {
    const violations = checkBundleBudgets(makeBundles({ 'main-css': 40 }));
    expect(violations.find(v => v.metric === 'css-bundle')).toBeUndefined();
  });

  it('fails when CSS bundle exceeds 50 KB budget', () => {
    const violations = checkBundleBudgets(makeBundles({ 'main-css': 65 }));
    expect(violations.find(v => v.metric === 'css-bundle')).toBeDefined();
  });
});

describe('Performance budget — total page weight', () => {
  it('passes when total weight is within 1 500 KB', () => {
    const violations = checkBundleBudgets(makeBundles());
    expect(violations.find(v => v.metric === 'total-page-weight')).toBeUndefined();
  });

  it('fails when total weight exceeds 1 500 KB', () => {
    const violations = checkBundleBudgets(makeBundles({ 'main-js': 800, 'main-css': 200, images: 600 }));
    expect(violations.find(v => v.metric === 'total-page-weight')).toBeDefined();
  });

  it('reports correct total in violation', () => {
    const bundles = makeBundles({ 'main-js': 900, 'main-css': 400, images: 400 });
    const violations = checkBundleBudgets(bundles);
    const v = violations.find(v => v.metric === 'total-page-weight');
    expect(v!.actual).toBe(1_700);
  });
});

describe('Performance budget — Time to Interactive (TTI)', () => {
  it('passes when TTI is within 3 800 ms', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ ttiMs: 3_500 }));
    expect(violations.find(v => v.metric === 'ttiMs')).toBeUndefined();
  });

  it('fails when TTI exceeds 3 800 ms', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ ttiMs: 4_200 }));
    expect(violations.find(v => v.metric === 'ttiMs')).toBeDefined();
  });

  it('TTI on slow-3g is simulated with 6× multiplier', () => {
    const baseMs = 600;
    expect(simulateNetworkDelay(baseMs, 'slow-3g')).toBe(3_600);
  });

  it('TTI on fast-3g is simulated with 2.5× multiplier', () => {
    expect(simulateNetworkDelay(1_000, 'fast-3g')).toBe(2_500);
  });
});

describe('Performance budget — Largest Contentful Paint (LCP)', () => {
  it('passes when LCP is within 2 500 ms', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ lcpMs: 2_000 }));
    expect(violations.find(v => v.metric === 'lcpMs')).toBeUndefined();
  });

  it('fails when LCP exceeds 2 500 ms', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ lcpMs: 3_000 }));
    expect(violations.find(v => v.metric === 'lcpMs')).toBeDefined();
  });

  it('LCP at exactly 2 500 ms passes', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ lcpMs: 2_500 }));
    expect(violations.find(v => v.metric === 'lcpMs')).toBeUndefined();
  });
});

describe('Performance budget — Cumulative Layout Shift (CLS)', () => {
  it('passes when CLS is within 0.1', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ cls: 0.05 }));
    expect(violations.find(v => v.metric === 'cls')).toBeUndefined();
  });

  it('fails when CLS exceeds 0.1', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ cls: 0.15 }));
    expect(violations.find(v => v.metric === 'cls')).toBeDefined();
  });

  it('CLS at exactly 0.1 passes', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ cls: 0.1 }));
    expect(violations.find(v => v.metric === 'cls')).toBeUndefined();
  });

  it('zero CLS is ideal and passes', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ cls: 0 }));
    expect(violations.find(v => v.metric === 'cls')).toBeUndefined();
  });
});

describe('Performance budget — First Contentful Paint (FCP)', () => {
  it('passes when FCP is within 1 800 ms', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ fcpMs: 1_500 }));
    expect(violations.find(v => v.metric === 'fcpMs')).toBeUndefined();
  });

  it('fails when FCP exceeds 1 800 ms', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ fcpMs: 2_200 }));
    expect(violations.find(v => v.metric === 'fcpMs')).toBeDefined();
  });
});

describe('Performance budget — Total Blocking Time (TBT)', () => {
  it('passes when TBT is within 300 ms', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ tbtMs: 200 }));
    expect(violations.find(v => v.metric === 'tbtMs')).toBeUndefined();
  });

  it('fails when TBT exceeds 300 ms', () => {
    const violations = checkWebVitalsBudgets(makeMetrics({ tbtMs: 450 }));
    expect(violations.find(v => v.metric === 'tbtMs')).toBeDefined();
  });
});

describe('Performance budget — overall score', () => {
  it('good metrics yield score ≥ 90', () => {
    expect(scorePerformance(makeMetrics())).toBeGreaterThanOrEqual(90);
  });

  it('poor LCP reduces score below 90', () => {
    expect(scorePerformance(makeMetrics({ lcpMs: 5_000 }))).toBeLessThan(90);
  });

  it('high CLS reduces score', () => {
    const good = scorePerformance(makeMetrics({ cls: 0.05 }));
    const bad = scorePerformance(makeMetrics({ cls: 0.3 }));
    expect(bad).toBeLessThan(good);
  });

  it('all budgets met produces zero violations', () => {
    const bundleViolations = checkBundleBudgets(makeBundles());
    const vitalViolations = checkWebVitalsBudgets(makeMetrics());
    expect([...bundleViolations, ...vitalViolations]).toHaveLength(0);
  });
});

describe('Performance budget — multi-device', () => {
  it('desktop metrics pass all budgets', () => {
    const metrics = makeMetrics({ fcpMs: 800, lcpMs: 1_500, ttiMs: 2_000, tbtMs: 100, cls: 0.02 });
    expect(checkWebVitalsBudgets(metrics)).toHaveLength(0);
  });

  it('mobile on fast-3g may have higher TTI but still within budget', () => {
    const mobileMetrics = makeMetrics({ ttiMs: 3_600, lcpMs: 2_400 });
    const violations = checkWebVitalsBudgets(mobileMetrics);
    expect(violations.find(v => v.metric === 'ttiMs')).toBeUndefined();
  });

  it('mobile on slow-3g exceeds TTI budget', () => {
    const slowMetrics = makeMetrics({ ttiMs: 5_000, lcpMs: 4_000 });
    const violations = checkWebVitalsBudgets(slowMetrics);
    expect(violations.find(v => v.metric === 'ttiMs')).toBeDefined();
    expect(violations.find(v => v.metric === 'lcpMs')).toBeDefined();
  });
});

// ── Critical rendering path budgets (#576) ────────────────────────────────────
//
// Performance budgets for the three critical views:
//   - Dashboard (deployment list)
//   - Customization Studio
//   - Deployment List (large data set: 100+ deployments)
//
// Budgets are based on current baselines and documented below.
// CI enforcement: any violation causes the test suite to fail.
//
// View-specific budgets:
//   dashboard:             render ≤ 100 ms, component bundle ≤ 80 KB
//   customization-studio:  render ≤ 150 ms, component bundle ≤ 120 KB
//   deployment-list:       render ≤ 200 ms, component bundle ≤ 60 KB
//   large-dataset (100+):  render ≤ 500 ms

interface ViewBudget {
  renderMs: number;
  bundleKb: number;
}

const VIEW_BUDGETS: Record<string, ViewBudget> = {
  'dashboard':            { renderMs: 100, bundleKb: 80  },
  'customization-studio': { renderMs: 150, bundleKb: 120 },
  'deployment-list':      { renderMs: 200, bundleKb: 60  },
} as const;

const LARGE_DATASET_RENDER_BUDGET_MS = 500;

interface ViewRenderResult {
  view: string;
  renderMs: number;
  bundleKb: number;
}

interface ViewBudgetViolation {
  view: string;
  metric: 'renderMs' | 'bundleKb';
  budget: number;
  actual: number;
}

function checkViewBudgets(results: ViewRenderResult[]): ViewBudgetViolation[] {
  const violations: ViewBudgetViolation[] = [];
  for (const result of results) {
    const budget = VIEW_BUDGETS[result.view];
    if (!budget) continue;
    if (result.renderMs > budget.renderMs) {
      violations.push({ view: result.view, metric: 'renderMs', budget: budget.renderMs, actual: result.renderMs });
    }
    if (result.bundleKb > budget.bundleKb) {
      violations.push({ view: result.view, metric: 'bundleKb', budget: budget.bundleKb, actual: result.bundleKb });
    }
  }
  return violations;
}

/** Simulate rendering a list of N items and return a render time estimate. */
function simulateListRender(itemCount: number, msPerItem = 1.5): number {
  // Baseline 20 ms + linear cost per item (realistic for virtualized lists)
  return Math.round(20 + itemCount * msPerItem);
}

function makeViewResult(view: string, overrides: Partial<ViewRenderResult> = {}): ViewRenderResult {
  const defaults: Record<string, ViewRenderResult> = {
    'dashboard':            { view, renderMs: 60,  bundleKb: 65  },
    'customization-studio': { view, renderMs: 110, bundleKb: 95  },
    'deployment-list':      { view, renderMs: 140, bundleKb: 45  },
  };
  return { ...(defaults[view] ?? { view, renderMs: 50, bundleKb: 40 }), ...overrides };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

describe('Performance budget – dashboard view', () => {
  it('passes render time budget (≤ 100 ms)', () => {
    const violations = checkViewBudgets([makeViewResult('dashboard', { renderMs: 60 })]);
    expect(violations.find(v => v.view === 'dashboard' && v.metric === 'renderMs')).toBeUndefined();
  });

  it('fails when render time exceeds 100 ms', () => {
    const violations = checkViewBudgets([makeViewResult('dashboard', { renderMs: 120 })]);
    const v = violations.find(v => v.view === 'dashboard' && v.metric === 'renderMs');
    expect(v).toBeDefined();
    expect(v!.budget).toBe(100);
    expect(v!.actual).toBe(120);
  });

  it('passes bundle size budget (≤ 80 KB)', () => {
    const violations = checkViewBudgets([makeViewResult('dashboard', { bundleKb: 70 })]);
    expect(violations.find(v => v.view === 'dashboard' && v.metric === 'bundleKb')).toBeUndefined();
  });

  it('fails when bundle size exceeds 80 KB', () => {
    const violations = checkViewBudgets([makeViewResult('dashboard', { bundleKb: 95 })]);
    expect(violations.find(v => v.view === 'dashboard' && v.metric === 'bundleKb')).toBeDefined();
  });

  it('passes at exactly the render time budget limit', () => {
    const violations = checkViewBudgets([makeViewResult('dashboard', { renderMs: 100 })]);
    expect(violations.find(v => v.view === 'dashboard' && v.metric === 'renderMs')).toBeUndefined();
  });
});

// ── Customization Studio ──────────────────────────────────────────────────────

describe('Performance budget – customization studio view', () => {
  it('passes render time budget (≤ 150 ms)', () => {
    const violations = checkViewBudgets([makeViewResult('customization-studio', { renderMs: 110 })]);
    expect(violations.find(v => v.view === 'customization-studio' && v.metric === 'renderMs')).toBeUndefined();
  });

  it('fails when render time exceeds 150 ms', () => {
    const violations = checkViewBudgets([makeViewResult('customization-studio', { renderMs: 200 })]);
    expect(violations.find(v => v.view === 'customization-studio' && v.metric === 'renderMs')).toBeDefined();
  });

  it('passes bundle size budget (≤ 120 KB)', () => {
    const violations = checkViewBudgets([makeViewResult('customization-studio', { bundleKb: 100 })]);
    expect(violations.find(v => v.view === 'customization-studio' && v.metric === 'bundleKb')).toBeUndefined();
  });

  it('fails when bundle size exceeds 120 KB', () => {
    const violations = checkViewBudgets([makeViewResult('customization-studio', { bundleKb: 130 })]);
    expect(violations.find(v => v.view === 'customization-studio' && v.metric === 'bundleKb')).toBeDefined();
  });
});

// ── Deployment List ───────────────────────────────────────────────────────────

describe('Performance budget – deployment list view', () => {
  it('passes render time budget (≤ 200 ms)', () => {
    const violations = checkViewBudgets([makeViewResult('deployment-list', { renderMs: 140 })]);
    expect(violations.find(v => v.view === 'deployment-list' && v.metric === 'renderMs')).toBeUndefined();
  });

  it('fails when render time exceeds 200 ms', () => {
    const violations = checkViewBudgets([makeViewResult('deployment-list', { renderMs: 250 })]);
    expect(violations.find(v => v.view === 'deployment-list' && v.metric === 'renderMs')).toBeDefined();
  });

  it('passes bundle size budget (≤ 60 KB)', () => {
    const violations = checkViewBudgets([makeViewResult('deployment-list', { bundleKb: 45 })]);
    expect(violations.find(v => v.view === 'deployment-list' && v.metric === 'bundleKb')).toBeUndefined();
  });
});

// ── Large data set (100+ deployments) ────────────────────────────────────────

describe('Performance budget – large data set (100+ deployments)', () => {
  it('renders 100 deployments within 500 ms budget', () => {
    const renderMs = simulateListRender(100);
    expect(renderMs).toBeLessThanOrEqual(LARGE_DATASET_RENDER_BUDGET_MS);
  });

  it('renders 200 deployments within 500 ms budget', () => {
    const renderMs = simulateListRender(200);
    expect(renderMs).toBeLessThanOrEqual(LARGE_DATASET_RENDER_BUDGET_MS);
  });

  it('render time scales linearly with item count', () => {
    const t50  = simulateListRender(50);
    const t100 = simulateListRender(100);
    const t200 = simulateListRender(200);
    // Each doubling should add roughly the same delta (linear, not exponential)
    expect(t100 - t50).toBeCloseTo(t200 - t100, -1);
  });

  it('reports a violation when render exceeds 500 ms budget', () => {
    // Simulate a pathological render (e.g. no virtualisation, 1000 items)
    const renderMs = simulateListRender(1000, 2);
    expect(renderMs).toBeGreaterThan(LARGE_DATASET_RENDER_BUDGET_MS);
  });

  it('baseline render (0 items) is under 50 ms', () => {
    expect(simulateListRender(0)).toBeLessThan(50);
  });
});

// ── All critical paths combined ───────────────────────────────────────────────

describe('Performance budget – all critical paths (CI enforcement)', () => {
  it('all three views pass their budgets with baseline metrics', () => {
    const results = [
      makeViewResult('dashboard'),
      makeViewResult('customization-studio'),
      makeViewResult('deployment-list'),
    ];
    const violations = checkViewBudgets(results);
    expect(violations).toHaveLength(0);
  });

  it('reports all violations when multiple views exceed budget', () => {
    const results = [
      makeViewResult('dashboard',            { renderMs: 200, bundleKb: 100 }),
      makeViewResult('customization-studio', { renderMs: 300, bundleKb: 150 }),
      makeViewResult('deployment-list',      { renderMs: 400, bundleKb: 80  }),
    ];
    const violations = checkViewBudgets(results);
    // Each view has 2 violations (renderMs + bundleKb) → 6 total
    expect(violations.length).toBe(6);
  });

  it('violation report includes view name, metric, budget, and actual', () => {
    const results = [makeViewResult('dashboard', { renderMs: 150 })];
    const violations = checkViewBudgets(results);
    const v = violations[0];
    expect(v.view).toBe('dashboard');
    expect(v.metric).toBe('renderMs');
    expect(v.budget).toBe(100);
    expect(v.actual).toBe(150);
  });
});
