/**
 * Trustline Validation Tests
 *
 * Tests for validating Stellar trustlines before asset issuance template deployment.
 */

import { describe, it, expect } from 'vitest';
import { Keypair } from 'stellar-sdk';
import {
  validateTrustlines,
  canEstablishTrustlines,
  validateAssetIssuanceDeployment,
  formatTrustlineError,
  MAX_TRUSTLINES_PER_ACCOUNT,
} from './trustline-validation';
import type { Horizon } from 'stellar-sdk';

describe('Trustline Validation', () => {
  const accountId = Keypair.random().publicKey();
  const issuer1 = Keypair.random().publicKey();
  const issuer2 = Keypair.random().publicKey();

  describe('validateTrustlines', () => {
    it('should accept valid account with required trustlines', async () => {
      const accountData = {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: issuer1,
            balance: '100',
            limit: '1000',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: false,
          },
        ],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateTrustlines(
        accountId,
        [{ code: 'USD', issuer: issuer1 }],
        accountData
      );

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.missingTrustlines).toBeUndefined();
    });

    it('should reject when trustline does not exist', async () => {
      const accountData = {
        balances: [],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateTrustlines(
        accountId,
        [{ code: 'USD', issuer: issuer1 }],
        accountData
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing or invalid trustlines');
      expect(result.missingTrustlines).toHaveLength(1);
      expect(result.missingTrustlines?.[0].asset).toBe('USD');
      expect(result.missingTrustlines?.[0].reason).toBe('Trustline does not exist');
    });

    it('should reject when trustline is not authorized', async () => {
      const accountData = {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: issuer1,
            balance: '0',
            limit: '1000',
            is_authorized: false,
            is_authorized_to_maintain_liabilities: false,
          },
        ],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateTrustlines(
        accountId,
        [{ code: 'USD', issuer: issuer1 }],
        accountData
      );

      expect(result.valid).toBe(false);
      expect(result.missingTrustlines).toHaveLength(1);
      expect(result.missingTrustlines?.[0].reason).toBe('Trustline exists but is not authorized');
    });

    it('should reject when trustline limit is maxed out', async () => {
      const accountData = {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: issuer1,
            balance: '1000',
            limit: '1000',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: false,
          },
        ],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateTrustlines(
        accountId,
        [{ code: 'USD', issuer: issuer1 }],
        accountData
      );

      expect(result.valid).toBe(false);
      expect(result.missingTrustlines).toHaveLength(1);
      expect(result.missingTrustlines?.[0].reason).toBe('Trustline limit is maxed out');
    });

    it('should accept native XLM without trustline', async () => {
      const accountData = {
        balances: [],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateTrustlines(
        accountId,
        [{ code: 'XLM', issuer: '' }],
        accountData
      );

      expect(result.valid).toBe(true);
    });

    it('should validate multiple trustlines', async () => {
      const accountData = {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: issuer1,
            balance: '100',
            limit: '1000',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: false,
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'EUR',
            asset_issuer: issuer2,
            balance: '50',
            limit: '500',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: false,
          },
        ],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateTrustlines(
        accountId,
        [
          { code: 'USD', issuer: issuer1 },
          { code: 'EUR', issuer: issuer2 },
        ],
        accountData
      );

      expect(result.valid).toBe(true);
    });

    it('should identify multiple missing trustlines', async () => {
      const accountData = {
        balances: [],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateTrustlines(
        accountId,
        [
          { code: 'USD', issuer: issuer1 },
          { code: 'EUR', issuer: issuer2 },
        ],
        accountData
      );

      expect(result.valid).toBe(false);
      expect(result.missingTrustlines).toHaveLength(2);
    });

    it('should reject invalid account address', async () => {
      const result = await validateTrustlines(
        'INVALID',
        [{ code: 'USD', issuer: issuer1 }]
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid account address format');
    });

    it('should accept trustline with maintain liabilities authorization', async () => {
      const accountData = {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: issuer1,
            balance: '100',
            limit: '1000',
            is_authorized: false,
            is_authorized_to_maintain_liabilities: true,
          },
        ],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateTrustlines(
        accountId,
        [{ code: 'USD', issuer: issuer1 }],
        accountData
      );

      expect(result.valid).toBe(true);
    });
  });

  describe('canEstablishTrustlines', () => {
    it('should allow establishing trustlines under limit', () => {
      const accountData = {
        balances: [
          { asset_type: 'native' },
          { asset_type: 'credit_alphanum4' },
          { asset_type: 'credit_alphanum4' },
        ],
      } as Horizon.ServerApi.AccountRecord;

      const result = canEstablishTrustlines(accountData, 5);

      expect(result).toBe(true);
    });

    it('should reject when at maximum trustline limit', () => {
      const balances = [{ asset_type: 'native' }];
      for (let i = 0; i < MAX_TRUSTLINES_PER_ACCOUNT; i++) {
        balances.push({ asset_type: 'credit_alphanum4' });
      }

      const accountData = {
        balances,
      } as Horizon.ServerApi.AccountRecord;

      const result = canEstablishTrustlines(accountData, 1);

      expect(result).toBe(false);
    });

    it('should reject when additional trustlines would exceed limit', () => {
      const balances = [{ asset_type: 'native' }];
      for (let i = 0; i < MAX_TRUSTLINES_PER_ACCOUNT - 2; i++) {
        balances.push({ asset_type: 'credit_alphanum4' });
      }

      const accountData = {
        balances,
      } as Horizon.ServerApi.AccountRecord;

      const result = canEstablishTrustlines(accountData, 3);

      expect(result).toBe(false);
    });

    it('should not count native balance as trustline', () => {
      const accountData = {
        balances: [
          { asset_type: 'native' },
          { asset_type: 'credit_alphanum4' },
        ],
      } as Horizon.ServerApi.AccountRecord;

      const result = canEstablishTrustlines(accountData, MAX_TRUSTLINES_PER_ACCOUNT - 1);

      expect(result).toBe(true);
    });
  });

  describe('validateAssetIssuanceDeployment', () => {
    it('should accept valid deployment', async () => {
      const accountData = {
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: issuer1,
            balance: '100',
            limit: '1000',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: false,
          },
        ],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateAssetIssuanceDeployment(
        accountId,
        [{ code: 'USD', issuer: issuer1 }],
        accountData
      );

      expect(result.valid).toBe(true);
    });

    it('should reject when trustlines are missing', async () => {
      const accountData = {
        balances: [],
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateAssetIssuanceDeployment(
        accountId,
        [{ code: 'USD', issuer: issuer1 }],
        accountData
      );

      expect(result.valid).toBe(false);
      expect(result.missingTrustlines).toHaveLength(1);
    });

    it('should reject when account cannot establish additional trustlines', async () => {
      const balances = [{ asset_type: 'native' }];
      for (let i = 0; i < MAX_TRUSTLINES_PER_ACCOUNT; i++) {
        balances.push({
          asset_type: 'credit_alphanum4',
          asset_code: `TOKEN${i}`,
          asset_issuer: Keypair.random().publicKey(),
          balance: '0',
          limit: '1000',
          is_authorized: true,
          is_authorized_to_maintain_liabilities: false,
        });
      }

      const accountData = {
        balances,
      } as Horizon.ServerApi.AccountRecord;

      const result = await validateAssetIssuanceDeployment(
        accountId,
        [{ code: 'NEWTOKEN', issuer: issuer1 }],
        accountData
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('maximum trustline limit');
    });
  });

  describe('formatTrustlineError', () => {
    it('should return empty string for valid result', () => {
      const result = { valid: true, maxSize: 1000 };
      const formatted = formatTrustlineError(result);

      expect(formatted).toBe('');
    });

    it('should format error with missing trustlines', () => {
      const result = {
        valid: false,
        error: 'Missing or invalid trustlines for 2 asset(s)',
        missingTrustlines: [
          { asset: 'USD', issuer: issuer1, reason: 'Trustline does not exist' },
          { asset: 'EUR', issuer: issuer2, reason: 'Trustline not authorized' },
        ],
      };

      const formatted = formatTrustlineError(result);

      expect(formatted).toContain('Missing or invalid trustlines');
      expect(formatted).toContain('USD');
      expect(formatted).toContain('EUR');
      expect(formatted).toContain('Trustline does not exist');
      expect(formatted).toContain('Trustline not authorized');
      expect(formatted).toContain('To fix this:');
    });

    it('should format error without missing trustlines', () => {
      const result = {
        valid: false,
        error: 'Invalid account address',
      };

      const formatted = formatTrustlineError(result);

      expect(formatted).toBe('Invalid account address');
    });

    it('should include remediation steps', () => {
      const result = {
        valid: false,
        error: 'Missing trustlines',
        missingTrustlines: [
          { asset: 'USD', issuer: issuer1, reason: 'Trustline does not exist' },
        ],
      };

      const formatted = formatTrustlineError(result);

      expect(formatted).toContain('Establish trustlines');
      expect(formatted).toContain('authorized by the issuer');
      expect(formatted).toContain('limits are not maxed out');
    });
  });
});
