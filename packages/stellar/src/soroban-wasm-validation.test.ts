/**
 * Soroban WASM Binary Size Validation Tests
 *
 * Tests for validating WASM binary size against Soroban deployment constraints.
 */

import { describe, it, expect } from 'vitest';
import { validateWasmSize, assertValidWasmSize, MAX_WASM_SIZE_BYTES } from './soroban';

describe('Soroban WASM Size Validation', () => {
  describe('validateWasmSize', () => {
    it('should accept WASM binary under size limit', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES - 1000);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(true);
      expect(result.size).toBe(MAX_WASM_SIZE_BYTES - 1000);
      expect(result.maxSize).toBe(MAX_WASM_SIZE_BYTES);
      expect(result.error).toBeUndefined();
    });

    it('should accept WASM binary at exact size limit', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(true);
      expect(result.size).toBe(MAX_WASM_SIZE_BYTES);
    });

    it('should reject WASM binary over size limit', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + 1);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(false);
      expect(result.size).toBe(MAX_WASM_SIZE_BYTES + 1);
      expect(result.maxSize).toBe(MAX_WASM_SIZE_BYTES);
      expect(result.error).toBeDefined();
    });

    it('should include size and limit in error message', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + 5000);
      const result = validateWasmSize(wasm);

      expect(result.error).toContain(`${MAX_WASM_SIZE_BYTES + 5000} bytes`);
      expect(result.error).toContain(`${MAX_WASM_SIZE_BYTES} bytes`);
      expect(result.error).toContain('5000 bytes');
    });

    it('should work with Uint8Array', () => {
      const wasm = new Uint8Array(MAX_WASM_SIZE_BYTES - 100);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(true);
      expect(result.size).toBe(MAX_WASM_SIZE_BYTES - 100);
    });

    it('should handle empty WASM binary', () => {
      const wasm = Buffer.alloc(0);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(true);
      expect(result.size).toBe(0);
    });

    it('should handle very small WASM binary', () => {
      const wasm = Buffer.alloc(100);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(true);
      expect(result.size).toBe(100);
    });
  });

  describe('assertValidWasmSize', () => {
    it('should not throw for valid WASM size', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES - 1000);

      expect(() => assertValidWasmSize(wasm)).not.toThrow();
    });

    it('should throw for oversized WASM binary', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + 1);

      expect(() => assertValidWasmSize(wasm)).toThrow();
    });

    it('should throw with descriptive error message', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + 5000);

      expect(() => assertValidWasmSize(wasm)).toThrow(/exceeds maximum allowed size/);
      expect(() => assertValidWasmSize(wasm)).toThrow(/5000 bytes/);
    });

    it('should work with Uint8Array', () => {
      const wasm = new Uint8Array(MAX_WASM_SIZE_BYTES + 1);

      expect(() => assertValidWasmSize(wasm)).toThrow();
    });
  });

  describe('Boundary Testing', () => {
    it('should accept binary at size limit minus 1', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES - 1);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(true);
    });

    it('should accept binary at exact size limit', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(true);
    });

    it('should reject binary at size limit plus 1', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + 1);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(false);
    });

    it('should reject binary significantly over limit', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES * 2);
      const result = validateWasmSize(wasm);

      expect(result.valid).toBe(false);
      expect(result.error).toContain(`${MAX_WASM_SIZE_BYTES} bytes`);
    });
  });

  describe('Error Message Quality', () => {
    it('should provide actionable error message', () => {
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + 10000);
      const result = validateWasmSize(wasm);

      expect(result.error).toContain('exceeds maximum allowed size');
      expect(result.error).toContain('Reduce contract size');
    });

    it('should show exact size difference', () => {
      const oversizeBy = 12345;
      const wasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + oversizeBy);
      const result = validateWasmSize(wasm);

      expect(result.error).toContain(`${oversizeBy} bytes`);
    });

    it('should include both actual and max size', () => {
      const actualSize = MAX_WASM_SIZE_BYTES + 5000;
      const wasm = Buffer.alloc(actualSize);
      const result = validateWasmSize(wasm);

      expect(result.error).toContain(`${actualSize} bytes`);
      expect(result.error).toContain(`${MAX_WASM_SIZE_BYTES} bytes`);
    });
  });

  describe('Integration Scenarios', () => {
    it('should validate before deployment workflow', () => {
      // Simulate a deployment workflow
      const contractWasm = Buffer.alloc(MAX_WASM_SIZE_BYTES - 1000);

      // Step 1: Validate size
      const validation = validateWasmSize(contractWasm);
      expect(validation.valid).toBe(true);

      // Step 2: If valid, proceed with deployment
      if (validation.valid) {
        // Deployment logic would go here
        expect(true).toBe(true);
      }
    });

    it('should block deployment for oversized binary', () => {
      const contractWasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + 1000);

      // Validation should fail
      const validation = validateWasmSize(contractWasm);
      expect(validation.valid).toBe(false);

      // Deployment should be blocked
      if (!validation.valid) {
        expect(validation.error).toBeDefined();
        // Would show error to user and prevent deployment
      }
    });

    it('should provide clear feedback for size optimization', () => {
      const oversizeBy = 8192; // 8 KB over
      const contractWasm = Buffer.alloc(MAX_WASM_SIZE_BYTES + oversizeBy);

      const validation = validateWasmSize(contractWasm);

      expect(validation.valid).toBe(false);
      expect(validation.error).toContain(`${oversizeBy} bytes`);

      // User knows exactly how much to reduce
      const reductionNeeded = validation.size! - validation.maxSize;
      expect(reductionNeeded).toBe(oversizeBy);
    });
  });

  describe('Size Limit Constant', () => {
    it('should have correct maximum size', () => {
      expect(MAX_WASM_SIZE_BYTES).toBe(65536); // 64 KB
    });

    it('should use consistent limit across validations', () => {
      const wasm1 = Buffer.alloc(MAX_WASM_SIZE_BYTES);
      const wasm2 = Buffer.alloc(MAX_WASM_SIZE_BYTES + 1);

      const result1 = validateWasmSize(wasm1);
      const result2 = validateWasmSize(wasm2);

      expect(result1.maxSize).toBe(result2.maxSize);
      expect(result1.maxSize).toBe(MAX_WASM_SIZE_BYTES);
    });
  });
});
