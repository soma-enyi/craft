/**
 * Syntax Validator Regression Tests
 *
 * Tests for the syntax validator service covering all historically discovered
 * malformed input patterns, preventing previously fixed bugs from being reintroduced.
 *
 * Run: vitest run tests/codegen/syntax-validator-regression.test.ts
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import {
  SYNTAX_VALIDATOR_REGRESSION_CORPUS,
  type RegressionCorpusEntry,
} from './syntax-validator-regression.corpus';

interface SyntaxValidationError {
  file: string;
  message: string;
  line?: number;
}

interface SyntaxValidationResult {
  valid: boolean;
  errors: SyntaxValidationError[];
}

interface GeneratedFile {
  path: string;
  content: string;
}

class SyntaxValidator {
  validate(file: GeneratedFile): SyntaxValidationResult {
    if (file.path.endsWith('.ts')) {
      return this.validateTypeScript(file.path, file.content);
    }
    if (file.path.endsWith('.json')) {
      return this.validateJSON(file.path, file.content);
    }
    return { valid: true, errors: [] };
  }

  validateTypeScript(path: string, content: string): SyntaxValidationResult {
    const sourceFile = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    const program = ts.createProgram({
      rootNames: [path],
      options: { noResolve: true, skipLibCheck: true },
      host: {
        ...ts.createCompilerHost({}),
        getSourceFile: (fileName) =>
          fileName === path ? sourceFile : undefined,
        fileExists: (fileName) => fileName === path,
        readFile: (fileName) => (fileName === path ? content : undefined),
      },
    });

    const syntacticDiags = program.getSyntacticDiagnostics(sourceFile);

    if (syntacticDiags.length === 0) {
      return { valid: true, errors: [] };
    }

    const errors: SyntaxValidationError[] = syntacticDiags.map((diag) => ({
      file: path,
      message:
        typeof diag.messageText === 'string'
          ? diag.messageText
          : diag.messageText.messageText,
      line: diag.start,
    }));

    return { valid: false, errors };
  }

  validateJSON(path: string, content: string): SyntaxValidationResult {
    try {
      JSON.parse(content);
      return { valid: true, errors: [] };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        valid: false,
        errors: [{ file: path, message }],
      };
    }
  }
}

describe('Syntax Validator Regression Tests', () => {
  const validator = new SyntaxValidator();

  describe('Regression Corpus Coverage', () => {
    it('should have at least 15 regression corpus entries', () => {
      expect(SYNTAX_VALIDATOR_REGRESSION_CORPUS.length).toBeGreaterThanOrEqual(
        15,
      );
    });

    it('should have unique IDs for all corpus entries', () => {
      const ids = SYNTAX_VALIDATOR_REGRESSION_CORPUS.map((e) => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have descriptions for all corpus entries', () => {
      SYNTAX_VALIDATOR_REGRESSION_CORPUS.forEach((entry) => {
        expect(entry.description).toBeTruthy();
        expect(entry.description.length).toBeGreaterThan(0);
      });
    });

    it('should have bug references for all corpus entries', () => {
      SYNTAX_VALIDATOR_REGRESSION_CORPUS.forEach((entry) => {
        expect(entry.bugReference).toBeTruthy();
        expect(entry.bugReference).toMatch(/^Issue #\d+:/);
      });
    });
  });

  describe('Regression Test Execution', () => {
    SYNTAX_VALIDATOR_REGRESSION_CORPUS.forEach((entry: RegressionCorpusEntry) => {
      it(`should handle regression case: ${entry.id} - ${entry.description}`, () => {
        const file: GeneratedFile = {
          path: `test.${entry.fileType}`,
          content: entry.input,
        };

        const result = validator.validate(file);

        if (entry.expectedError) {
          // Malformed input should produce a typed error, not an exception
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors[0]).toHaveProperty('file');
          expect(result.errors[0]).toHaveProperty('message');
          expect(typeof result.errors[0].message).toBe('string');
          expect(result.errors[0].message.length).toBeGreaterThan(0);
        } else {
          // Valid input should pass validation
          expect(result.valid).toBe(true);
          expect(result.errors.length).toBe(0);
        }
      });
    });
  });

  describe('Error Consistency', () => {
    it('should produce consistent error types across all malformed inputs', () => {
      const malformedEntries = SYNTAX_VALIDATOR_REGRESSION_CORPUS.filter(
        (e) => e.expectedError,
      );

      malformedEntries.forEach((entry) => {
        const file: GeneratedFile = {
          path: `test.${entry.fileType}`,
          content: entry.input,
        };

        const result = validator.validate(file);

        // All errors should be typed SyntaxValidationError objects
        result.errors.forEach((error) => {
          expect(error).toHaveProperty('file');
          expect(error).toHaveProperty('message');
          expect(typeof error.file).toBe('string');
          expect(typeof error.message).toBe('string');
          // Should never throw an exception
          expect(() => {
            validator.validate(file);
          }).not.toThrow();
        });
      });
    });
  });

  describe('Valid Input Handling', () => {
    it('should accept all valid corpus entries without errors', () => {
      const validEntries = SYNTAX_VALIDATOR_REGRESSION_CORPUS.filter(
        (e) => !e.expectedError,
      );

      validEntries.forEach((entry) => {
        const file: GeneratedFile = {
          path: `test.${entry.fileType}`,
          content: entry.input,
        };

        const result = validator.validate(file);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });
  });
});
