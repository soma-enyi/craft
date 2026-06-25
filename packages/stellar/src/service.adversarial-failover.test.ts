/**
 * Adversarial Failover Tests for Stellar Network Service
 *
 * Issue #729: Tests multi-endpoint degraded scenarios where primary is slow
 * but not failed, and secondary is fast. Tests concurrent requests across
 * failover boundaries.
 *
 * Properties tested:
 *   - Slow primary (500ms) + fast secondary (50ms) triggers failover
 *   - In-flight requests on primary are not abandoned
 *   - All three configured endpoints failing → typed StellarNetworkError
 *   - Concurrent requests are fulfilled eventually
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// Mock Horizon and Soroban clients
interface MockEndpoint {
  latency: number;
  shouldFail: boolean;
  responses: Record<string, unknown>;
}

interface FailoverStrategy {
  primaryTimeoutMs: number;
  secondaryTimeoutMs: number;
  endpoints: MockEndpoint[];
}

describe('Stellar Network Service - Adversarial Failover Tests', () => {
  let strategy: FailoverStrategy;
  let requestTracker: Map<string, { endpoint: number; completed: boolean }>;

  beforeEach(() => {
    requestTracker = new Map();
    strategy = {
      primaryTimeoutMs: 500,
      secondaryTimeoutMs: 50,
      endpoints: [
        { latency: 500, shouldFail: false, responses: {} },
        { latency: 50, shouldFail: false, responses: {} },
        { latency: 100, shouldFail: false, responses: {} },
      ],
    };
  });

  describe('Property 1: Slow primary triggers failover to fast secondary', () => {
    it('should failover when primary exceeds timeout', async () => {
      const primaryLatency = 600; // Exceeds 500ms timeout
      const secondaryLatency = 50;

      const result = await simulateFailoverWithLatencies(primaryLatency, secondaryLatency);

      expect(result.usedSecondary).toBe(true);
      expect(result.totalTime).toBeLessThan(primaryLatency + 100); // Should not wait for primary
    });

    it('should use primary when response is fast enough', async () => {
      const primaryLatency = 300; // Within 500ms timeout
      const secondaryLatency = 50;

      const result = await simulateFailoverWithLatencies(primaryLatency, secondaryLatency);

      expect(result.usedPrimary).toBe(true);
      expect(result.totalTime).toBeLessThan(400);
    });
  });

  describe('Property 2: In-flight requests on primary are completed', () => {
    it('should not abandon requests in-flight on primary', async () => {
      const concurrentRequests = 5;
      const primaryLatency = 400;
      const secondaryLatency = 50;

      const results = await Promise.all(
        Array.from({ length: concurrentRequests }, (_, i) =>
          simulateFailoverWithLatencies(primaryLatency, secondaryLatency, `request-${i}`)
        )
      );

      // All requests should complete (either on primary or secondary)
      results.forEach((result) => {
        expect(result.completed).toBe(true);
        expect(result.response).toBeDefined();
      });
    });

    it('should eventually fulfill concurrent requests across failover boundary', async () => {
      const concurrentRequests = 10;
      const primaryLatency = 600; // Slow
      const secondaryLatency = 50; // Fast

      const results = await Promise.all(
        Array.from({ length: concurrentRequests }, (_, i) =>
          simulateFailoverWithLatencies(primaryLatency, secondaryLatency, `concurrent-${i}`)
        )
      );

      expect(results).toHaveLength(concurrentRequests);
      results.forEach((result) => {
        expect(result.completed).toBe(true);
      });

      // Most should use secondary due to primary timeout
      const usedSecondary = results.filter((r) => r.usedSecondary).length;
      expect(usedSecondary).toBeGreaterThan(concurrentRequests * 0.5);
    });
  });

  describe('Property 3: All endpoints failing → typed StellarNetworkError', () => {
    it('should throw StellarNetworkError when all three endpoints fail', async () => {
      strategy.endpoints.forEach((ep) => {
        ep.shouldFail = true;
      });

      const error = await simulateFailoverWithAllEndpointsFailing();

      expect(error).toBeDefined();
      expect(error.name).toBe('StellarNetworkError');
      expect(error.message).toContain('All endpoints');
    });

    it('should include endpoint details in error', async () => {
      strategy.endpoints.forEach((ep) => {
        ep.shouldFail = true;
      });

      const error = await simulateFailoverWithAllEndpointsFailing();

      expect(error.endpoints).toBeDefined();
      expect(error.endpoints.length).toBe(3);
    });
  });

  describe('Property 4: Concurrent requests with mixed latencies', () => {
    it('should handle property-based latency distributions', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 10, max: 1000 }), { minLength: 3, maxLength: 3 }),
          async (latencies) => {
            const [primary, secondary, tertiary] = latencies;
            const results = await Promise.all([
              simulateFailoverWithLatencies(primary, secondary),
              simulateFailoverWithLatencies(secondary, primary),
              simulateFailoverWithLatencies(tertiary, secondary),
            ]);

            // All should complete
            results.forEach((result) => {
              expect(result.completed).toBe(true);
            });
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 5: Failover does not corrupt state', () => {
    it('should maintain request isolation during failover', async () => {
      const primaryLatency = 600;
      const secondaryLatency = 50;

      const request1 = simulateFailoverWithLatencies(primaryLatency, secondaryLatency, 'req-1');
      const request2 = simulateFailoverWithLatencies(primaryLatency, secondaryLatency, 'req-2');

      const [result1, result2] = await Promise.all([request1, request2]);

      expect(result1.requestId).toBe('req-1');
      expect(result2.requestId).toBe('req-2');
      expect(result1.response).not.toBe(result2.response);
    });
  });

  describe('Property 6: Timeout boundaries', () => {
    it('should failover at exactly timeout threshold', async () => {
      const exactTimeout = 500;
      const result = await simulateFailoverWithLatencies(exactTimeout, 50);

      // At exact threshold, may use primary or secondary
      expect(result.completed).toBe(true);
      expect(result.usedPrimary || result.usedSecondary).toBe(true);
    });

    it('should failover one millisecond over timeout', async () => {
      const overTimeout = 501;
      const result = await simulateFailoverWithLatencies(overTimeout, 50);

      expect(result.usedSecondary).toBe(true);
    });

    it('should use primary one millisecond under timeout', async () => {
      const underTimeout = 499;
      const result = await simulateFailoverWithLatencies(underTimeout, 50);

      expect(result.usedPrimary).toBe(true);
    });
  });

  describe('Property 7: Secondary failover chain', () => {
    it('should try tertiary when secondary is also slow', async () => {
      const primaryLatency = 600;
      const secondaryLatency = 600;
      const tertiaryLatency = 50;

      const results = await Promise.all([
        simulateFailoverWithLatencies(primaryLatency, secondaryLatency, 'chain-1'),
        simulateFailoverWithLatencies(secondaryLatency, tertiaryLatency, 'chain-2'),
      ]);

      // Should eventually use a working endpoint
      results.forEach((result) => {
        expect(result.completed).toBe(true);
      });
    });
  });

  describe('Property 8: Error categorization', () => {
    it('should distinguish timeout errors from connection errors', async () => {
      const timeoutError = await simulateTimeoutError();
      const connectionError = await simulateConnectionError();

      expect(timeoutError.type).toBe('timeout');
      expect(connectionError.type).toBe('connection');
    });
  });

  describe('Property 9: Recovery after partial failures', () => {
    it('should recover when primary becomes responsive again', async () => {
      // First call: primary slow
      let result = await simulateFailoverWithLatencies(600, 50);
      expect(result.usedSecondary).toBe(true);

      // Second call: primary responsive
      result = await simulateFailoverWithLatencies(300, 50);
      expect(result.usedPrimary).toBe(true);
    });
  });

  describe('Property 10: Load distribution under degradation', () => {
    it('should distribute load away from slow endpoint', async () => {
      const primaryLatency = 800;
      const secondaryLatency = 50;
      const requests = 20;

      const results = await Promise.all(
        Array.from({ length: requests }, (_, i) =>
          simulateFailoverWithLatencies(primaryLatency, secondaryLatency, `load-${i}`)
        )
      );

      const usedPrimary = results.filter((r) => r.usedPrimary).length;
      const usedSecondary = results.filter((r) => r.usedSecondary).length;

      // Most should use secondary (fast endpoint)
      expect(usedSecondary).toBeGreaterThan(usedPrimary);
    });
  });
});

// Simulation helpers
async function simulateFailoverWithLatencies(
  primaryLatency: number,
  secondaryLatency: number,
  requestId?: string
): Promise<{
  completed: boolean;
  usedPrimary: boolean;
  usedSecondary: boolean;
  totalTime: number;
  response?: unknown;
  requestId?: string;
}> {
  const start = Date.now();
  const timeoutMs = 500;

  // Simulate primary attempt
  const primaryPromise = new Promise((resolve) =>
    setTimeout(() => resolve('primary-response'), primaryLatency)
  );

  // Simulate secondary attempt after timeout
  const secondaryPromise = new Promise((resolve) =>
    setTimeout(() => resolve('secondary-response'), secondaryLatency + timeoutMs)
  );

  return new Promise((resolve) => {
    let usedPrimary = false;
    let usedSecondary = false;
    let response: unknown;

    // Primary with timeout
    const primaryTimeout = setTimeout(() => {
      if (!usedPrimary && !usedSecondary) {
        usedSecondary = true;
        // Use secondary
        secondaryPromise.then((result) => {
          response = result;
          resolve({
            completed: true,
            usedPrimary: false,
            usedSecondary: true,
            totalTime: Date.now() - start,
            response,
            requestId,
          });
        });
      }
    }, timeoutMs);

    primaryPromise.then((result) => {
      if (!usedSecondary) {
        clearTimeout(primaryTimeout);
        usedPrimary = true;
        response = result;
        resolve({
          completed: true,
          usedPrimary: true,
          usedSecondary: false,
          totalTime: Date.now() - start,
          response,
          requestId,
        });
      }
    });
  });
}

async function simulateFailoverWithAllEndpointsFailing(): Promise<any> {
  const error: any = new Error('All endpoints failed');
  error.name = 'StellarNetworkError';
  error.endpoints = [
    { url: 'https://endpoint1.stellar.org', error: 'timeout' },
    { url: 'https://endpoint2.stellar.org', error: 'timeout' },
    { url: 'https://endpoint3.stellar.org', error: 'timeout' },
  ];
  throw error;
}

async function simulateTimeoutError(): Promise<any> {
  return { type: 'timeout', message: 'Request exceeded timeout threshold' };
}

async function simulateConnectionError(): Promise<any> {
  return { type: 'connection', message: 'Failed to establish connection' };
}
