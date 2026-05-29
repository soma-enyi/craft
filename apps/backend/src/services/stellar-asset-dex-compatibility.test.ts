/**
 * Stellar Asset Code DEX Compatibility Tests (#620)
 *
 * Tests valid alphanum4/alphanum12 asset codes and rejection of
 * DEX-incompatible assets with clear error messages.
 */

import { describe, it, expect } from 'vitest';
import {
    validateAssetCodeDexCompatibility,
    resolveAssetVariant,
} from './stellar-asset-validator.service';

// ---------------------------------------------------------------------------
// resolveAssetVariant
// ---------------------------------------------------------------------------

describe('resolveAssetVariant', () => {
    it('returns "native" for XLM', () => {
        expect(resolveAssetVariant('XLM')).toBe('native');
    });

    it('returns "alphanum4" for 1-4 char codes', () => {
        expect(resolveAssetVariant('A')).toBe('alphanum4');
        expect(resolveAssetVariant('USDC')).toBe('alphanum4');
    });

    it('returns "alphanum12" for 5-12 char codes', () => {
        expect(resolveAssetVariant('MYTKN')).toBe('alphanum12');
        expect(resolveAssetVariant('STELLARCOIN')).toBe('alphanum12');
    });

    it('returns null for codes longer than 12 chars', () => {
        expect(resolveAssetVariant('TOOLONGASSET1')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// validateAssetCodeDexCompatibility
// ---------------------------------------------------------------------------

describe('validateAssetCodeDexCompatibility – valid codes', () => {
    it('accepts XLM as native and DEX-compatible', () => {
        const result = validateAssetCodeDexCompatibility('XLM');
        expect(result.compatible).toBe(true);
        expect(result.variant).toBe('native');
    });

    it('accepts valid alphanum4 codes', () => {
        for (const code of ['USD', 'USDC', 'BTC', 'A']) {
            const result = validateAssetCodeDexCompatibility(code);
            expect(result.compatible).toBe(true);
            expect(result.variant).toBe('alphanum4');
        }
    });

    it('accepts valid alphanum12 codes', () => {
        for (const code of ['MYTOKEN', 'STELLARCOIN', 'TOKEN12']) {
            const result = validateAssetCodeDexCompatibility(code);
            expect(result.compatible).toBe(true);
            expect(result.variant).toBe('alphanum12');
        }
    });
});

describe('validateAssetCodeDexCompatibility – invalid / incompatible codes', () => {
    it('rejects empty string', () => {
        const result = validateAssetCodeDexCompatibility('');
        expect(result.compatible).toBe(false);
        expect(result.error?.code).toBe('ASSET_CODE_EMPTY');
    });

    it('rejects non-string input', () => {
        const result = validateAssetCodeDexCompatibility(null);
        expect(result.compatible).toBe(false);
    });

    it('rejects codes with special characters', () => {
        const result = validateAssetCodeDexCompatibility('USD-C');
        expect(result.compatible).toBe(false);
        expect(result.error?.code).toBe('ASSET_CODE_INVALID_CHARSET');
    });

    it('rejects lowercase codes as DEX-incompatible', () => {
        const result = validateAssetCodeDexCompatibility('usdc');
        expect(result.compatible).toBe(false);
        expect(result.error?.code).toBe('DEX_INCOMPATIBLE_CHARSET');
        expect(result.error?.message).toContain('lowercase');
    });

    it('rejects mixed-case codes as DEX-incompatible', () => {
        const result = validateAssetCodeDexCompatibility('Usdc');
        expect(result.compatible).toBe(false);
        expect(result.error?.code).toBe('DEX_INCOMPATIBLE_CHARSET');
    });

    it('rejects codes longer than 12 characters', () => {
        const result = validateAssetCodeDexCompatibility('TOOLONGASSET1');
        expect(result.compatible).toBe(false);
        expect(result.error?.code).toBe('ASSET_CODE_INVALID_LENGTH');
    });

    it('provides a clear, actionable error message for lowercase codes', () => {
        const result = validateAssetCodeDexCompatibility('mytoken');
        expect(result.compatible).toBe(false);
        expect(result.error?.message).toContain('DEX liquidity pools');
    });
});
