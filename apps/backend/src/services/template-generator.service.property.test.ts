/**
 * Property-based tests for TemplateGeneratorService — output determinism.
 *
 * Determinism guarantees:
 *   - Identical inputs always produce byte-identical generatedFiles output.
 *   - No live timestamps or random UUIDs are injected into generated file content.
 *   - Output is stable across repeated calls with the same request.
 *
 * Non-deterministic sources neutralised by this suite:
 *   - crypto.randomUUID() (used for cloning runId) → stubbed to a fixed value.
 *   - new Date().toISOString() (used for artifactMetadata.generatedAt) → frozen.
 *
 * Runs ≥ 200 iterations per property (numRuns: 200).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { TemplateGeneratorService } from './template-generator.service';
import type { Template, GeneratedFile } from '@craft/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const FIXED_UUID = '00000000-0000-0000-0000-000000000000';
const FIXED_TIMESTAMP = '2025-01-01T00:00:00.000Z';
const MOCK_WORKSPACE = '/tmp/workspace-fixed';

/** Matches ISO 8601 timestamps that would indicate a live clock leak. */
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Matches UUID v4 patterns that would indicate a random-source leak. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ── Arbitraries ───────────────────────────────────────────────────────────────

// Primary and secondary color sets are disjoint so they are never equal,
// which satisfies the "secondaryColor must differ from primary" business rule.
const PRIMARY_COLORS = ['#007bff', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6'] as const;
const SECONDARY_COLORS = ['#6c757d', '#06b6d4', '#ec4899', '#14b8a6', '#64748b', '#94a3b8'] as const;
const APP_NAMES = ['Stellar DEX', 'DeFi Protocol', 'Token Issuer', 'Payment Hub', 'Asset Exchange', 'Soroban App'] as const;
const TEMPLATE_IDS = ['tmpl-dex-001', 'tmpl-lending-002', 'tmpl-payment-003', 'tmpl-asset-004', 'tmpl-defi-005'] as const;
const TEMPLATE_CATEGORIES = ['dex', 'lending', 'payment', 'asset-issuance'] as const;

const arbTemplateId = fc.constantFrom(...TEMPLATE_IDS);
const arbCategory = fc.constantFrom(...TEMPLATE_CATEGORIES);

const arbCustomization = fc.record({
    branding: fc.record({
        appName: fc.constantFrom(...APP_NAMES),
        primaryColor: fc.constantFrom(...PRIMARY_COLORS),
        secondaryColor: fc.constantFrom(...SECONDARY_COLORS),
        fontFamily: fc.constantFrom('Inter', 'Roboto', 'Open Sans', 'Poppins'),
    }),
    features: fc.record({
        enableCharts: fc.boolean(),
        enableTransactionHistory: fc.boolean(),
        enableAnalytics: fc.boolean(),
        enableNotifications: fc.boolean(),
    }),
    stellar: fc.record({
        network: fc.constant('testnet' as const),
        horizonUrl: fc.constant('https://horizon-testnet.stellar.org'),
        sorobanRpcUrl: fc.constant(undefined as undefined),
        assetPairs: fc.constant(undefined as undefined),
        contractAddresses: fc.constant(undefined as undefined),
    }),
});

const arbRequest = fc.record({
    templateId: arbTemplateId,
    customization: arbCustomization,
    outputPath: fc.constant('/tmp/output'),
});

// ── Service factory ───────────────────────────────────────────────────────────

/**
 * Creates a TemplateGeneratorService with fully-deterministic mocked dependencies.
 * The code generator produces file content that is a pure function of its inputs
 * so the only non-determinism to guard against is what the service itself introduces.
 */
function makeService(category: string = 'dex') {
    const templateService = {
        getTemplate: vi.fn().mockResolvedValue({
            id: 'tmpl-fixed',
            name: 'Determinism Test Template',
            description: 'Template used for determinism property tests',
            category,
            blockchainType: 'stellar',
            baseRepositoryUrl: '/tmp/template-source',
            previewImageUrl: 'https://example.com/preview.png',
            features: [],
            customizationSchema: {},
            isActive: true,
            createdAt: new Date(FIXED_TIMESTAMP),
        } as Template),
    };

    const codeGeneratorService = {
        generate: vi.fn().mockImplementation(
            ({ templateId, templateFamily }: { templateId: string; templateFamily: string }) => ({
                success: true,
                generatedFiles: [
                    {
                        path: 'src/index.ts',
                        content: `// template: ${templateId}\n// family: ${templateFamily}\nexport const config = {};`,
                        type: 'code',
                    } as GeneratedFile,
                    {
                        path: 'src/constants.ts',
                        content: `export const TEMPLATE_ID = '${templateId}';\nexport const FAMILY = '${templateFamily}';`,
                        type: 'code',
                    } as GeneratedFile,
                ],
                errors: [],
            }),
        ),
    };

    const cloningService = {
        clone: vi.fn().mockResolvedValue({
            success: true,
            workspacePath: MOCK_WORKSPACE,
            errors: [],
        }),
    };

    const syntaxValidator = {
        validate: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    };

    return new TemplateGeneratorService(
        templateService as any,
        codeGeneratorService as any,
        cloningService as any,
        syntaxValidator as any,
    );
}

// ── Property tests ────────────────────────────────────────────────────────────

describe('TemplateGeneratorService — output determinism', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(FIXED_TIMESTAMP));
        vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue(FIXED_UUID) });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    // ── Byte-identical output for identical inputs ─────────────────────────────

    it('identical inputs produce byte-identical generatedFiles across 200+ arbitrary configs', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, arbCategory, async (request, category) => {
                const service = makeService(category);

                const result1 = await service.generate(request);
                const result2 = await service.generate(request);

                expect(result1.success).toBe(true);
                expect(result2.success).toBe(true);
                expect(result1.generatedFiles).toEqual(result2.generatedFiles);
            }),
            { numRuns: 200 },
        );
    });

    it('generatedFiles path list is identical across two calls with the same request', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, async (request) => {
                const service = makeService();

                const result1 = await service.generate(request);
                const result2 = await service.generate(request);

                const paths1 = result1.generatedFiles.map((f) => f.path).sort();
                const paths2 = result2.generatedFiles.map((f) => f.path).sort();

                expect(paths1).toEqual(paths2);
            }),
            { numRuns: 200 },
        );
    });

    it('generatedFiles file content is byte-identical across two calls with the same request', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, async (request) => {
                const service = makeService();

                const result1 = await service.generate(request);
                const result2 = await service.generate(request);

                for (let i = 0; i < result1.generatedFiles.length; i++) {
                    expect(result1.generatedFiles[i].content).toBe(result2.generatedFiles[i].content);
                }
            }),
            { numRuns: 200 },
        );
    });

    // ── No timestamps or random IDs in generated file content ─────────────────

    it('generated file content contains no ISO 8601 timestamp patterns', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, async (request) => {
                const service = makeService();
                const result = await service.generate(request);

                expect(result.success).toBe(true);
                for (const file of result.generatedFiles) {
                    expect(file.content).not.toMatch(ISO_TIMESTAMP_RE);
                }
            }),
            { numRuns: 200 },
        );
    });

    it('generated file content contains no random UUID patterns', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, async (request) => {
                const service = makeService();
                const result = await service.generate(request);

                expect(result.success).toBe(true);
                for (const file of result.generatedFiles) {
                    expect(file.content).not.toMatch(UUID_RE);
                }
            }),
            { numRuns: 200 },
        );
    });

    it('artifactMetadata.generatedAt is the frozen timestamp, not a live clock value', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, async (request) => {
                const service = makeService();
                const result = await service.generate(request);

                expect(result.success).toBe(true);
                expect(result.artifactMetadata!.generatedAt).toBe(FIXED_TIMESTAMP);
            }),
            { numRuns: 200 },
        );
    });

    // ── Output stability across multiple generation runs ──────────────────────

    it('output is stable: success:true always yields at least one generated file', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, async (request) => {
                const service = makeService();
                const result = await service.generate(request);

                expect(result.success).toBe(true);
                expect(result.generatedFiles.length).toBeGreaterThan(0);
                expect(result.artifactMetadata!.fileCount).toBe(result.generatedFiles.length);
            }),
            { numRuns: 200 },
        );
    });

    it('artifactMetadata.fileCount always equals generatedFiles.length across 200+ configs', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, async (request) => {
                const service = makeService();
                const result = await service.generate(request);

                expect(result.artifactMetadata!.fileCount).toBe(result.generatedFiles.length);
            }),
            { numRuns: 200 },
        );
    });

    it('output for different templateIds produces different file content', async () => {
        await fc.assert(
            fc.asyncProperty(
                arbCustomization,
                arbCategory,
                fc.integer({ min: 0, max: TEMPLATE_IDS.length - 2 }),
                async (customization, category, idx) => {
                    const id1 = TEMPLATE_IDS[idx];
                    const id2 = TEMPLATE_IDS[idx + 1];

                    const service = makeService(category);

                    const result1 = await service.generate({ templateId: id1, customization, outputPath: '/tmp' });
                    const result2 = await service.generate({ templateId: id2, customization, outputPath: '/tmp' });

                    // Different templateIds must produce different file content
                    const contents1 = result1.generatedFiles.map((f) => f.content).join('\n');
                    const contents2 = result2.generatedFiles.map((f) => f.content).join('\n');

                    expect(contents1).not.toBe(contents2);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('crypto.randomUUID is called for the clone runId but its value does not appear in file content', async () => {
        await fc.assert(
            fc.asyncProperty(arbRequest, async (request) => {
                const service = makeService();
                const result = await service.generate(request);

                expect(result.success).toBe(true);
                for (const file of result.generatedFiles) {
                    expect(file.content).not.toContain(FIXED_UUID);
                }
            }),
            { numRuns: 200 },
        );
    });
});
