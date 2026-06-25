/**
 * Property-Based Tests for Stellar Asset Pair Validation
 *
 * Issue #720: Tests that validate asset pair validation under malformed inputs
 * using property-based testing with fast-check.
 *
 * Properties tested:
 *   - Any asset code longer than 12 characters must fail
 *   - Native XLM paired with itself must fail
 *   - Non-G58 issuers must fail
 *   - All constraints are properly enforced
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateAssetPairs } from './validate-asset-pairs';
import type { StellarAsset, AssetPair } from '@craft/types';

// Arbitraries for generating test data
const arbValidAssetCode = fc
  .stringMatching(/^[A-Z0-9]{1,12}$/)
  .filter(code => code.length >= 1 && code.length <= 12);

const arbInvalidAssetCode = fc
  .stringMatching(/^[A-Z0-9]{13,20}$/)
  .filter(code => code.length > 12);

const arbValidStellarPublicKey = (): fc.Arbitrary<string> => {
  return fc.stringMatching(/^G[A-Z2-7]{55}$/)
    .filter(key => key.startsWith('G') && key.length === 56);
};

const arbInvalidStellarPublicKey = (): fc.Arbitrary<string> => {
  return fc
    .oneof(
      fc.stringMatching(/^[^G][A-Z0-9]{55}$/), // wrong first char
      fc.stringMatching(/^G[A-Z0-9]{54}$/), // too short
      fc.stringMatching(/^G[A-Z0-9]{56}$/), // too long
      fc.string().filter(s => !s.startsWith('G') || s.length !== 56)
    )
    .filter(key => !key.match(/^G[A-Z2-7]{55}$/));
};

const arbNativeAsset = (): fc.Arbitrary<StellarAsset> => {
  return fc.constant({
    type: 'native' as const,
    code: 'XLM',
    issuer: '',
  });
};

const arbCreditAsset = (type: 'credit_alphanum4' | 'credit_alphanum12'): fc.Arbitrary<StellarAsset> => {
  if (type === 'credit_alphanum4') {
    return fc.tuple(
      fc.stringMatching(/^[A-Z0-9]{1,4}$/),
      arbValidStellarPublicKey()
    ).map(([code, issuer]) => ({
      type,
      code,
      issuer,
    }));
  } else {
    return fc.tuple(
      fc.stringMatching(/^[A-Z0-9]{5,12}$/),
      arbValidStellarPublicKey()
    ).map(([code, issuer]) => ({
      type,
      code,
      issuer,
    }));
  }
};

describe('validateAssetPairs - Property Tests', () => {
  describe('Property 1: Asset codes longer than 12 chars must fail', () => {
    it('should reject any asset with code > 12 characters', () => {
      fc.assert(
        fc.property(arbInvalidAssetCode, arbValidStellarPublicKey(), (code, issuer) => {
          const pairs = [{
            base: { type: 'credit_alphanum12' as const, code, issuer },
            counter: { type: 'native' as const, code: 'XLM', issuer: '' },
          }];
          
          const errors = validateAssetPairs(pairs);
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.some(e => e.field.includes('base.code'))).toBe(true);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 2: Native XLM paired with itself must fail', () => {
    it('should reject identical assets in a pair', () => {
      fc.assert(
        fc.property(fc.constant(undefined), () => {
          const pairs = [{
            base: { type: 'native' as const, code: 'XLM', issuer: '' },
            counter: { type: 'native' as const, code: 'XLM', issuer: '' },
          }];
          
          const errors = validateAssetPairs(pairs);
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.some(e => e.code === 'ASSET_PAIR_IDENTICAL_ASSETS')).toBe(true);
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 3: Non-G58 issuers must fail', () => {
    it('should reject invalid Stellar public key issuers', () => {
      fc.assert(
        fc.property(arbValidAssetCode, arbInvalidStellarPublicKey(), (code, issuer) => {
          const pairs = [{
            base: { type: 'credit_alphanum12' as const, code: code.slice(0, 12), issuer },
            counter: { type: 'native' as const, code: 'XLM', issuer: '' },
          }];
          
          const errors = validateAssetPairs(pairs);
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.some(e => e.code === 'ASSET_INVALID_ISSUER')).toBe(true);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 4: Valid pairs must pass validation', () => {
    it('should accept valid asset pairs', () => {
      fc.assert(
        fc.property(
          arbCreditAsset('credit_alphanum4'),
          arbCreditAsset('credit_alphanum12'),
          (asset1, asset2) => {
            const pairs = [{ base: asset1, counter: asset2 }];
            const errors = validateAssetPairs(pairs);
            expect(errors.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 5: Error messages are human-readable', () => {
    it('should provide clear error messages without SDK leakage', () => {
      fc.assert(
        fc.property(arbInvalidAssetCode, arbValidStellarPublicKey(), (code, issuer) => {
          const pairs = [{
            base: { type: 'credit_alphanum12' as const, code, issuer },
            counter: { type: 'native' as const, code: 'XLM', issuer: '' },
          }];
          
          const errors = validateAssetPairs(pairs);
          errors.forEach(error => {
            expect(error.message).toBeTruthy();
            expect(typeof error.message).toBe('string');
            expect(error.message.length).toBeGreaterThan(0);
            // Ensure no raw SDK errors like "[Object object]" or stack traces
            expect(error.message).not.toMatch(/\[Object/);
            expect(error.message).not.toMatch(/at\s+/);
          });
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 6: Boundary conditions', () => {
    it('should reject alphanum4 with code > 4 characters', () => {
      const code = 'USDTA'; // 5 chars, invalid for alphanum4
      const issuer = 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQSTACTCKMULWGDDQ3VJWQ2ZSOIS';
      
      const pairs = [{
        base: { type: 'credit_alphanum4' as const, code, issuer },
        counter: { type: 'native' as const, code: 'XLM', issuer: '' },
      }];
      
      const errors = validateAssetPairs(pairs);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.code === 'ASSET_CODE_TOO_LONG')).toBe(true);
    });

    it('should reject alphanum12 with code <= 4 characters', () => {
      const code = 'USDT'; // 4 chars, invalid for alphanum12
      const issuer = 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQSTACTCKMULWGDDQ3VJWQ2ZSOIS';
      
      const pairs = [{
        base: { type: 'credit_alphanum12' as const, code, issuer },
        counter: { type: 'native' as const, code: 'XLM', issuer: '' },
      }];
      
      const errors = validateAssetPairs(pairs);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.code === 'ASSET_CODE_TOO_SHORT')).toBe(true);
    });
  });

  describe('Property 7: Valid pair combinations', () => {
    it('should accept multiple different pairs', () => {
      // Valid Stellar public keys (56 chars: G + 55 base32 chars A-Z, 2-7)
      const issuer1 = 'GBRPYHIL2CI3WHZDTUYQFC6EB4PSQSTACTCKMULWGDDQ3VJWQ2ZSOAC';
      const issuer2 = 'GCKFBEYBVSX7KKOJL5SI4ONHG3GYQP6UWJUQAIWU2HYRNQRWDKXZZZZ';
      
      const pairs = [
        {
          base: { type: 'credit_alphanum4' as const, code: 'USDT', issuer: issuer1 },
          counter: { type: 'credit_alphanum4' as const, code: 'EURC', issuer: issuer2 },
        },
        {
          base: { type: 'credit_alphanum12' as const, code: 'SOMETOKEN', issuer: issuer1 },
          counter: { type: 'credit_alphanum4' as const, code: 'BRL', issuer: issuer2 },
        },
      ];
      
      const errors = validateAssetPairs(pairs);
      expect(errors.length).toBe(0);
    });
  });
});
