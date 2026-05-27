import { describe, it, expect } from 'vitest';
import {
    checkRequestSize,
    formatBytes,
    validateContentLength,
    DEFAULT_MAX_REQUEST_SIZE,
    DEFAULT_MAX_BRANDING_FILE_SIZE,
} from './validate-request-size';

describe('validate-request-size', () => {
    describe('checkRequestSize', () => {
        it('should return size for valid content-length', () => {
            const size = checkRequestSize('1024', DEFAULT_MAX_REQUEST_SIZE);
            expect(size).toBe(1024);
        });

        it('should return null for missing content-length', () => {
            const size = checkRequestSize(null, DEFAULT_MAX_REQUEST_SIZE);
            expect(size).toBeNull();
        });

        it('should return null when size exceeds limit', () => {
            const size = checkRequestSize(
                String(DEFAULT_MAX_REQUEST_SIZE + 1),
                DEFAULT_MAX_REQUEST_SIZE,
            );
            expect(size).toBeNull();
        });

        it('should return null for invalid content-length', () => {
            const size = checkRequestSize('invalid', DEFAULT_MAX_REQUEST_SIZE);
            expect(size).toBeNull();
        });

        it('should accept size equal to limit', () => {
            const size = checkRequestSize(String(DEFAULT_MAX_REQUEST_SIZE), DEFAULT_MAX_REQUEST_SIZE);
            expect(size).toBe(DEFAULT_MAX_REQUEST_SIZE);
        });
    });

    describe('formatBytes', () => {
        it('should format bytes correctly', () => {
            expect(formatBytes(0)).toBe('0 bytes');
            expect(formatBytes(1024)).toBe('1 KB');
            expect(formatBytes(1024 * 1024)).toBe('1 MB');
            expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
        });

        it('should round to 2 decimal places', () => {
            expect(formatBytes(1536)).toBe('1.5 KB');
            expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
        });

        it('should handle large files', () => {
            const result = formatBytes(5 * 1024 * 1024);
            expect(result).toContain('MB');
            expect(parseFloat(result)).toBe(5);
        });
    });

    describe('validateContentLength', () => {
        it('should validate correct content-length', () => {
            const result = validateContentLength('1024', DEFAULT_MAX_REQUEST_SIZE);
            expect(result.valid).toBe(true);
            if (result.valid) {
                expect(result.size).toBe(1024);
            }
        });

        it('should reject missing content-length', () => {
            const result = validateContentLength(null, DEFAULT_MAX_REQUEST_SIZE);
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.message).toContain('Content-Length');
            }
        });

        it('should reject invalid content-length', () => {
            const result = validateContentLength('invalid', DEFAULT_MAX_REQUEST_SIZE);
            expect(result.valid).toBe(false);
        });

        it('should reject oversized content-length', () => {
            const result = validateContentLength(
                String(DEFAULT_MAX_BRANDING_FILE_SIZE + 1),
                DEFAULT_MAX_BRANDING_FILE_SIZE,
            );
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.message).toContain('exceeds maximum');
            }
        });

        it('should include formatted sizes in error message', () => {
            const result = validateContentLength(
                String(10 * 1024 * 1024),
                DEFAULT_MAX_BRANDING_FILE_SIZE,
            );
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.message).toContain('MB');
            }
        });
    });
});
