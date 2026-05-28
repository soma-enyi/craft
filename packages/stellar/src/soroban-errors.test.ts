/**
 * Soroban Contract Error Code Taxonomy Tests
 *
 * Tests for mapping Soroban contract error codes to typed application errors.
 */

import { describe, it, expect } from 'vitest';
import { mapSorobanError, parseStellarError, getErrorGuidance } from './errors';

describe('Soroban Error Code Taxonomy', () => {
  describe('mapSorobanError', () => {
    it('should map type mismatch errors', () => {
      const error = mapSorobanError('scvUnexpectedType');

      expect(error.code).toBe('SOROBAN_CONTRACT_ERROR');
      expect(error.title).toBe('Type Mismatch');
      expect(error.message).toContain('unexpected value type');
      expect(error.retryable).toBe(false);
      expect(error.resultCode).toBe('scvUnexpectedType');
    });

    it('should map contract panic errors', () => {
      const error = mapSorobanError('scvContractPanic');

      expect(error.code).toBe('SOROBAN_CONTRACT_PANIC');
      expect(error.title).toBe('Contract Panic');
      expect(error.message).toContain('panicked unexpectedly');
      expect(error.retryable).toBe(false);
    });

    it('should map resource limit errors', () => {
      const error = mapSorobanError('scvExceededLimit');

      expect(error.code).toBe('SOROBAN_RESOURCE_LIMIT_EXCEEDED');
      expect(error.title).toBe('Resource Limit Exceeded');
      expect(error.message).toContain('exceeded resource limits');
      expect(error.retryable).toBe(false);
    });

    it('should map storage errors', () => {
      const error = mapSorobanError('scvStorageError');

      expect(error.code).toBe('SOROBAN_STORAGE_ERROR');
      expect(error.title).toBe('Storage Error');
      expect(error.message).toContain('storage access error');
      expect(error.retryable).toBe(false);
    });

    it('should map auth errors', () => {
      const error = mapSorobanError('scvAuthError');

      expect(error.code).toBe('SOROBAN_AUTH_ERROR');
      expect(error.title).toBe('Authorization Error');
      expect(error.message).toContain('authorization failed');
      expect(error.retryable).toBe(false);
    });

    it('should map WASM errors', () => {
      const error = mapSorobanError('scvWasmTrap');

      expect(error.code).toBe('SOROBAN_WASM_ERROR');
      expect(error.title).toBe('WASM Trap');
      expect(error.message).toContain('WASM execution trapped');
      expect(error.retryable).toBe(false);
    });

    it('should provide fallback for unknown error codes', () => {
      const error = mapSorobanError('scvUnknownError');

      expect(error.code).toBe('SOROBAN_CONTRACT_ERROR');
      expect(error.title).toBe('Unknown Soroban Error');
      expect(error.message).toContain('scvUnknownError');
      expect(error.retryable).toBe(false);
    });
  });

  describe('parseStellarError with Soroban errors', () => {
    it('should parse Soroban contract errors from Error objects', () => {
      const error = new Error('Contract failed: scvUnexpectedType - type mismatch');
      const parsed = parseStellarError(error);

      expect(parsed.code).toBe('SOROBAN_CONTRACT_ERROR');
      expect(parsed.title).toBe('Type Mismatch');
      expect(parsed.retryable).toBe(false);
    });

    it('should parse Soroban panic errors', () => {
      const error = new Error('Soroban contract panicked: scvContractPanic');
      const parsed = parseStellarError(error);

      expect(parsed.code).toBe('SOROBAN_CONTRACT_PANIC');
      expect(parsed.title).toBe('Contract Panic');
    });

    it('should parse resource limit errors', () => {
      const error = new Error('scvCpuLimitExceeded: CPU limit exceeded');
      const parsed = parseStellarError(error);

      expect(parsed.code).toBe('SOROBAN_RESOURCE_LIMIT_EXCEEDED');
      expect(parsed.title).toBe('CPU Limit Exceeded');
    });

    it('should parse storage errors', () => {
      const error = new Error('scvStorageKeyNotFound: key not found');
      const parsed = parseStellarError(error);

      expect(parsed.code).toBe('SOROBAN_STORAGE_ERROR');
      expect(parsed.title).toBe('Storage Key Not Found');
    });

    it('should parse auth errors', () => {
      const error = new Error('scvInvalidSignature: signature verification failed');
      const parsed = parseStellarError(error);

      expect(parsed.code).toBe('SOROBAN_AUTH_ERROR');
      expect(parsed.title).toBe('Invalid Signature');
    });

    it('should handle generic Soroban errors without specific code', () => {
      const error = new Error('Soroban contract execution failed');
      const parsed = parseStellarError(error);

      expect(parsed.code).toBe('SOROBAN_CONTRACT_ERROR');
    });
  });

  describe('Error Guidance for Soroban Errors', () => {
    it('should provide guidance for contract errors', () => {
      const guidance = getErrorGuidance('SOROBAN_CONTRACT_ERROR');

      expect(guidance.template.title).toBe('Soroban Contract Error');
      expect(guidance.steps).toHaveLength(4);
      expect(guidance.links).toHaveLength(2);
      expect(guidance.links[0].label).toContain('Soroban');
    });

    it('should provide guidance for panic errors', () => {
      const guidance = getErrorGuidance('SOROBAN_CONTRACT_PANIC');

      expect(guidance.template.title).toBe('Soroban Contract Panic');
      expect(guidance.steps.length).toBeGreaterThan(0);
      expect(guidance.steps.some((s) => s.includes('panic'))).toBe(true);
    });

    it('should provide guidance for resource limit errors', () => {
      const guidance = getErrorGuidance('SOROBAN_RESOURCE_LIMIT_EXCEEDED');

      expect(guidance.template.title).toBe('Soroban Resource Limit Exceeded');
      expect(guidance.steps.some((s) => s.includes('resource'))).toBe(true);
    });

    it('should provide guidance for storage errors', () => {
      const guidance = getErrorGuidance('SOROBAN_STORAGE_ERROR');

      expect(guidance.template.title).toBe('Soroban Storage Error');
      expect(guidance.steps.some((s) => s.includes('storage'))).toBe(true);
    });

    it('should provide guidance for auth errors', () => {
      const guidance = getErrorGuidance('SOROBAN_AUTH_ERROR');

      expect(guidance.template.title).toBe('Soroban Authorization Error');
      expect(guidance.steps.some((s) => s.includes('authorization'))).toBe(true);
    });

    it('should provide guidance for WASM errors', () => {
      const guidance = getErrorGuidance('SOROBAN_WASM_ERROR');

      expect(guidance.template.title).toBe('Soroban WASM Error');
      expect(guidance.steps.some((s) => s.includes('WASM'))).toBe(true);
    });
  });

  describe('Error Code Coverage', () => {
    const knownSorobanCodes = [
      'scvUnexpectedType',
      'scvMissingValue',
      'scvInvalidInput',
      'scvArithmeticError',
      'scvIndexBounds',
      'scvInvalidAction',
      'scvContractPanic',
      'scvUnwrapFailed',
      'scvAssertionFailed',
      'scvInsufficientRefundableFee',
      'scvExceededLimit',
      'scvInsufficientBalance',
      'scvStorageExhausted',
      'scvCpuLimitExceeded',
      'scvMemoryLimitExceeded',
      'scvStorageError',
      'scvStorageKeyNotFound',
      'scvAuthError',
      'scvInvalidSignature',
      'scvWasmTrap',
      'scvWasmMemoryError',
      'scvInvalidWasm',
    ];

    it('should map all known Soroban error codes', () => {
      for (const code of knownSorobanCodes) {
        const error = mapSorobanError(code);

        expect(error).toBeDefined();
        expect(error.code).toMatch(/^SOROBAN_/);
        expect(error.title).toBeTruthy();
        expect(error.message).toBeTruthy();
        expect(typeof error.retryable).toBe('boolean');
      }
    });

    it('should categorize error codes correctly', () => {
      // Host function errors
      expect(mapSorobanError('scvUnexpectedType').code).toBe('SOROBAN_CONTRACT_ERROR');
      expect(mapSorobanError('scvArithmeticError').code).toBe('SOROBAN_CONTRACT_ERROR');

      // Panic errors
      expect(mapSorobanError('scvContractPanic').code).toBe('SOROBAN_CONTRACT_PANIC');
      expect(mapSorobanError('scvUnwrapFailed').code).toBe('SOROBAN_CONTRACT_PANIC');

      // Resource limit errors
      expect(mapSorobanError('scvExceededLimit').code).toBe('SOROBAN_RESOURCE_LIMIT_EXCEEDED');
      expect(mapSorobanError('scvCpuLimitExceeded').code).toBe('SOROBAN_RESOURCE_LIMIT_EXCEEDED');

      // Storage errors
      expect(mapSorobanError('scvStorageError').code).toBe('SOROBAN_STORAGE_ERROR');
      expect(mapSorobanError('scvStorageKeyNotFound').code).toBe('SOROBAN_STORAGE_ERROR');

      // Auth errors
      expect(mapSorobanError('scvAuthError').code).toBe('SOROBAN_AUTH_ERROR');
      expect(mapSorobanError('scvInvalidSignature').code).toBe('SOROBAN_AUTH_ERROR');

      // WASM errors
      expect(mapSorobanError('scvWasmTrap').code).toBe('SOROBAN_WASM_ERROR');
      expect(mapSorobanError('scvInvalidWasm').code).toBe('SOROBAN_WASM_ERROR');
    });
  });

  describe('Fallback Behavior', () => {
    it('should handle unknown error codes gracefully', () => {
      const unknownCodes = [
        'scvNewErrorCode',
        'scvFutureError',
        'scvCustomError',
      ];

      for (const code of unknownCodes) {
        const error = mapSorobanError(code);

        expect(error.code).toBe('SOROBAN_CONTRACT_ERROR');
        expect(error.title).toBe('Unknown Soroban Error');
        expect(error.message).toContain(code);
        expect(error.retryable).toBe(false);
      }
    });

    it('should include error code in fallback message', () => {
      const error = mapSorobanError('scvCustomError123');

      expect(error.message).toContain('scvCustomError123');
      expect(error.message).toContain('Check the contract logs');
    });
  });
});
