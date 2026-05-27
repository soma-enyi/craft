/**
 * Syntax Validator Regression Test Corpus
 *
 * This file contains a collection of historically problematic malformed inputs
 * that previously caused bugs or crashes in the syntax validator.
 * Each entry documents the failure mode it guards against.
 *
 * When a new syntax validator bug is discovered and fixed, add a new entry
 * to this corpus to prevent regression.
 */

export interface RegressionCorpusEntry {
  id: string;
  description: string;
  input: string;
  fileType: 'ts' | 'json';
  expectedError: boolean;
  bugReference?: string;
}

export const SYNTAX_VALIDATOR_REGRESSION_CORPUS: RegressionCorpusEntry[] = [
  {
    id: 'unclosed-brace-ts',
    description: 'Unclosed curly brace in TypeScript',
    input: `export function test() { console.log('hello')`,
    fileType: 'ts',
    expectedError: true,
    bugReference: 'Issue #401: Parser crash on unclosed braces',
  },
  {
    id: 'unclosed-paren-ts',
    description: 'Unclosed parenthesis in function call',
    input: `const result = Math.max(1, 2, 3;`,
    fileType: 'ts',
    expectedError: true,
    bugReference: 'Issue #402: Parenthesis mismatch not detected',
  },
  {
    id: 'invalid-import-ts',
    description: 'Invalid import statement syntax',
    input: `import { Component from 'react';`,
    fileType: 'ts',
    expectedError: true,
    bugReference: 'Issue #403: Import parsing failed silently',
  },
  {
    id: 'trailing-comma-ts',
    description: 'Trailing comma in object literal',
    input: `const obj = { a: 1, b: 2, };`,
    fileType: 'ts',
    expectedError: false,
    bugReference: 'Issue #404: Trailing commas incorrectly flagged as errors',
  },
  {
    id: 'template-literal-unclosed-ts',
    description: 'Unclosed template literal',
    input: 'const str = `hello world;',
    fileType: 'ts',
    expectedError: true,
    bugReference: 'Issue #405: Template literal parsing crash',
  },
  {
    id: 'nested-generics-ts',
    description: 'Deeply nested generic types',
    input: `type Deep = Array<Array<Array<Array<string>>>>;`,
    fileType: 'ts',
    expectedError: false,
    bugReference: 'Issue #406: Nested generics caused stack overflow',
  },
  {
    id: 'arrow-function-no-body-ts',
    description: 'Arrow function without body',
    input: `const fn = () =>`,
    fileType: 'ts',
    expectedError: true,
    bugReference: 'Issue #407: Arrow function incomplete detection',
  },
  {
    id: 'invalid-json-trailing-comma',
    description: 'JSON with trailing comma',
    input: `{"key": "value",}`,
    fileType: 'json',
    expectedError: true,
    bugReference: 'Issue #408: JSON trailing comma not rejected',
  },
  {
    id: 'invalid-json-single-quotes',
    description: 'JSON with single quotes instead of double',
    input: `{'key': 'value'}`,
    fileType: 'json',
    expectedError: true,
    bugReference: 'Issue #409: JSON single quote validation',
  },
  {
    id: 'invalid-json-unquoted-key',
    description: 'JSON with unquoted keys',
    input: `{key: "value"}`,
    fileType: 'json',
    expectedError: true,
    bugReference: 'Issue #410: JSON unquoted key detection',
  },
  {
    id: 'empty-json-object',
    description: 'Empty JSON object',
    input: `{}`,
    fileType: 'json',
    expectedError: false,
    bugReference: 'Issue #411: Empty objects incorrectly rejected',
  },
  {
    id: 'empty-json-array',
    description: 'Empty JSON array',
    input: `[]`,
    fileType: 'json',
    expectedError: false,
    bugReference: 'Issue #412: Empty arrays incorrectly rejected',
  },
  {
    id: 'unicode-escape-ts',
    description: 'Unicode escape sequences in strings',
    input: `const str = "\\u0048\\u0065\\u006c\\u006c\\u006f";`,
    fileType: 'ts',
    expectedError: false,
    bugReference: 'Issue #413: Unicode escapes caused parsing errors',
  },
  {
    id: 'regex-literal-ts',
    description: 'Regular expression literal with special chars',
    input: `const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/;`,
    fileType: 'ts',
    expectedError: false,
    bugReference: 'Issue #414: Regex literals misinterpreted as division',
  },
  {
    id: 'multiline-string-ts',
    description: 'Multiline template literal with expressions',
    input: `const msg = \`Line 1
Line 2
Value: \${value}\`;`,
    fileType: 'ts',
    expectedError: false,
    bugReference: 'Issue #415: Multiline template literals failed parsing',
  },
];
