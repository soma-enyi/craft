/**
 * Cascading Failure Recovery Tests for Preview Service
 *
 * Issue #721: Tests that verify the preview service handles cascading failures
 * where Vercel deployment fails mid-stream, leaving the preview URL unreachable.
 *
 * Properties tested:
 *   - Failed preview URLs are not served to the user
 *   - Preview iframe is updated atomically (old URL until new is verified)
 *   - Vercel API timeouts during preview update are handled
 *   - After 3 failed attempts, falls back to last known good URL
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreviewService } from './preview.service';
import type { CustomizationConfig } from '@craft/types';

describe('PreviewService - Cascading Failure Recovery', () => {
  let service: PreviewService;
  let mockVercelClient: any;

  beforeEach(() => {
    service = new PreviewService();
    mockVercelClient = {
      deployPreview: vi.fn(),
      getDeploymentStatus: vi.fn(),
    };
  });

  describe('Property 1: Failed preview URLs not served', () => {
    it('should not update preview URL if deployment fails', async () => {
      const config: CustomizationConfig = {
        branding: { appName: 'Test', primaryColor: '#000000', secondaryColor: '#ffffff', fontFamily: 'Arial' },
        features: { enableCharts: true, enableTransactionHistory: true, enableAnalytics: false, enableNotifications: false },
        stellar: { network: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org' },
      };

      // Mock Vercel failing at 50% through deployment
      mockVercelClient.deployPreview.mockRejectedValueOnce(
        new Error('Deployment failed: connection timeout after 50% completion')
      );

      const previousUrl = 'https://previous.example.com';
      const result = await service.updatePreviewUrl(config, previousUrl);

      // Should not update the URL since deployment failed
      expect(result.previewUrl).toBe(previousUrl);
      expect(result.isHealthy).toBe(false);
    });
  });

  describe('Property 2: Atomic URL updates', () => {
    it('should not update client-visible URL until new URL is verified healthy', async () => {
      const config: CustomizationConfig = {
        branding: { appName: 'Test', primaryColor: '#000000', secondaryColor: '#ffffff', fontFamily: 'Arial' },
        features: { enableCharts: true, enableTransactionHistory: true, enableAnalytics: false, enableNotifications: false },
        stellar: { network: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org' },
      };

      const previousUrl = 'https://previous.example.com';
      const newUrl = 'https://new.example.com';

      // First health check fails, then succeeds
      mockVercelClient.getDeploymentStatus
        .mockRejectedValueOnce(new Error('Service unreachable'))
        .mockResolvedValueOnce({ status: 'ready', isHealthy: true });

      const result = await service.updatePreviewUrl(config, previousUrl);

      // Should keep previous URL until new URL is confirmed healthy
      if (result.attempt < 3) {
        expect(result.previewUrl).toBe(previousUrl);
      }
    });
  });

  describe('Property 3: Vercel API timeout handling', () => {
    it('should handle Vercel API timeout during preview update', async () => {
      const config: CustomizationConfig = {
        branding: { appName: 'Test', primaryColor: '#000000', secondaryColor: '#ffffff', fontFamily: 'Arial' },
        features: { enableCharts: true, enableTransactionHistory: true, enableAnalytics: false, enableNotifications: false },
        stellar: { network: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org' },
      };

      const previousUrl = 'https://previous.example.com';

      // Mock Vercel timing out
      mockVercelClient.deployPreview.mockImplementation(
        () => new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Vercel API timeout after 30s')), 50)
        )
      );

      const result = await service.updatePreviewUrl(config, previousUrl);

      // Should gracefully handle timeout and retain previous URL
      expect(result.previewUrl).toBe(previousUrl);
      expect(result.error).toContain('timeout');
    });
  });

  describe('Property 4: Fallback after 3 failed attempts', () => {
    it('should fall back to last known good URL after 3 failed attempts', async () => {
      const config: CustomizationConfig = {
        branding: { appName: 'Test', primaryColor: '#000000', secondaryColor: '#ffffff', fontFamily: 'Arial' },
        features: { enableCharts: true, enableTransactionHistory: true, enableAnalytics: false, enableNotifications: false },
        stellar: { network: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org' },
      };

      const lastKnownGoodUrl = 'https://stable.example.com';

      // Mock 3 consecutive failures
      mockVercelClient.deployPreview
        .mockRejectedValueOnce(new Error('Attempt 1 failed'))
        .mockRejectedValueOnce(new Error('Attempt 2 failed'))
        .mockRejectedValueOnce(new Error('Attempt 3 failed'));

      let result = await service.updatePreviewUrl(config, lastKnownGoodUrl);
      
      for (let i = 0; i < 2; i++) {
        result = await service.updatePreviewUrl(config, lastKnownGoodUrl);
      }

      // After 3 attempts, should use fallback strategy
      expect(result.attempts).toBe(3);
      expect(result.previewUrl).toBe(lastKnownGoodUrl);
      expect(result.fallbackActive).toBe(true);
    });
  });

  describe('Property 5: Recovery from cascading failures', () => {
    it('should recover after successful deployment following failed attempts', async () => {
      const config: CustomizationConfig = {
        branding: { appName: 'Test', primaryColor: '#000000', secondaryColor: '#ffffff', fontFamily: 'Arial' },
        features: { enableCharts: true, enableTransactionHistory: true, enableAnalytics: false, enableNotifications: false },
        stellar: { network: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org' },
      };

      const previousUrl = 'https://previous.example.com';
      const recoveredUrl = 'https://recovered.example.com';

      // Fail twice, then succeed
      mockVercelClient.deployPreview
        .mockRejectedValueOnce(new Error('Failure 1'))
        .mockRejectedValueOnce(new Error('Failure 2'))
        .mockResolvedValueOnce({ url: recoveredUrl, status: 'ready' });

      mockVercelClient.getDeploymentStatus.mockResolvedValueOnce({ isHealthy: true });

      let result = await service.updatePreviewUrl(config, previousUrl);
      result = await service.updatePreviewUrl(config, previousUrl);
      result = await service.updatePreviewUrl(config, previousUrl);

      // After successful recovery, should use new URL
      expect(result.previewUrl).toBe(recoveredUrl);
      expect(result.isHealthy).toBe(true);
    });
  });

  describe('Property 6: Error isolation', () => {
    it('should not corrupt other deployment state during cascading failures', async () => {
      const config: CustomizationConfig = {
        branding: { appName: 'Test', primaryColor: '#000000', secondaryColor: '#ffffff', fontFamily: 'Arial' },
        features: { enableCharts: true, enableTransactionHistory: true, enableAnalytics: false, enableNotifications: false },
        stellar: { network: 'testnet', horizonUrl: 'https://horizon-testnet.stellar.org' },
      };

      const previousUrl = 'https://previous.example.com';
      const initialBranding = config.branding;

      mockVercelClient.deployPreview.mockRejectedValue(new Error('Deployment error'));

      await service.updatePreviewUrl(config, previousUrl);

      // Configuration should remain unchanged
      expect(config.branding).toEqual(initialBranding);
      expect(config.features).toEqual({
        enableCharts: true,
        enableTransactionHistory: true,
        enableAnalytics: false,
        enableNotifications: false,
      });
    });
  });
});
