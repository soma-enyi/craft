/**
 * Snapshot Regression Tests for Stellar Config Generator
 *
 * Captures and diffs Stellar configuration generation outputs to catch
 * unintended changes in environment variable serialization, runtime config
 * shapes, and generated file content.
 *
 * Issue: #540
 */

import { describe, it, expect } from 'vitest';
import {
    buildStellarEnvVars,
    buildStellarRuntimeConfig,
    generateStellarConfigFile,
    formatAssetLabel,
    requiresSoroban,
    usesAssetPairs,
    usesContractAddresses,
} from './stellar-config-generator';
import type { StellarConfig, AssetPair } from '@craft/types';

const testnetConfig: StellarConfig = {
    network: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    assetPairs: [
        {
            id: 'xlm-usdc',
            baseAsset: { type: 'native' },
            quoteAsset: {
                type: 'credit_alphanum12',
                code: 'USDC',
                issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            },
        },
    ],
    contractAddresses: {
        amm: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
};

const mainnetConfig: StellarConfig = {
    network: 'mainnet',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://mainnet.stellar.validationcloud.io/v1/soroban/rpc',
    assetPairs: [],
    contractAddresses: {},
};

describe('StellarConfigGenerator — Snapshot Regression Tests (#540)', () => {
    describe('buildStellarEnvVars — testnet', () => {
        it('should match snapshot for testnet env vars', () => {
            const envVars = buildStellarEnvVars(testnetConfig);
            expect(envVars).toMatchSnapshot();
        });

        it('should have all required env var keys', () => {
            const envVars = buildStellarEnvVars(testnetConfig);
            expect(Object.keys(envVars).sort()).toMatchSnapshot();
        });

        it('should serialize asset pairs correctly', () => {
            const envVars = buildStellarEnvVars(testnetConfig);
            expect(envVars.NEXT_PUBLIC_ASSET_PAIRS).toMatchSnapshot();
            if (envVars.NEXT_PUBLIC_ASSET_PAIRS) {
                const parsed = JSON.parse(envVars.NEXT_PUBLIC_ASSET_PAIRS);
                expect(parsed).toMatchSnapshot();
            }
        });

        it('should serialize contract addresses correctly', () => {
            const envVars = buildStellarEnvVars(testnetConfig);
            expect(envVars.NEXT_PUBLIC_CONTRACT_ADDRESSES).toMatchSnapshot();
            if (envVars.NEXT_PUBLIC_CONTRACT_ADDRESSES) {
                const parsed = JSON.parse(envVars.NEXT_PUBLIC_CONTRACT_ADDRESSES);
                expect(parsed).toMatchSnapshot();
            }
        });
    });

    describe('buildStellarEnvVars — mainnet', () => {
        it('should match snapshot for mainnet env vars', () => {
            const envVars = buildStellarEnvVars(mainnetConfig);
            expect(envVars).toMatchSnapshot();
        });

        it('should have correct network value', () => {
            const envVars = buildStellarEnvVars(mainnetConfig);
            expect(envVars.NEXT_PUBLIC_STELLAR_NETWORK).toBe('mainnet');
            expect(envVars.NEXT_PUBLIC_STELLAR_NETWORK).toMatchSnapshot();
        });

        it('should have correct Horizon URL', () => {
            const envVars = buildStellarEnvVars(mainnetConfig);
            expect(envVars.NEXT_PUBLIC_HORIZON_URL).toBe('https://horizon.stellar.org');
            expect(envVars.NEXT_PUBLIC_HORIZON_URL).toMatchSnapshot();
        });
    });

    describe('buildStellarRuntimeConfig — testnet', () => {
        it('should match snapshot for testnet runtime config', () => {
            const config = buildStellarRuntimeConfig(testnetConfig);
            expect(config).toMatchSnapshot();
        });

        it('should have all required fields', () => {
            const config = buildStellarRuntimeConfig(testnetConfig);
            expect(Object.keys(config).sort()).toMatchSnapshot();
        });

        it('should have correct network value', () => {
            const config = buildStellarRuntimeConfig(testnetConfig);
            expect(config.network).toBe('testnet');
            expect(config.network).toMatchSnapshot();
        });

        it('should have correct asset pairs', () => {
            const config = buildStellarRuntimeConfig(testnetConfig);
            expect(config.assetPairs).toMatchSnapshot();
        });

        it('should have correct contract addresses', () => {
            const config = buildStellarRuntimeConfig(testnetConfig);
            expect(config.contractAddresses).toMatchSnapshot();
        });
    });

    describe('buildStellarRuntimeConfig — mainnet', () => {
        it('should match snapshot for mainnet runtime config', () => {
            const config = buildStellarRuntimeConfig(mainnetConfig);
            expect(config).toMatchSnapshot();
        });

        it('should have empty asset pairs when not provided', () => {
            const config = buildStellarRuntimeConfig(mainnetConfig);
            expect(config.assetPairs).toEqual([]);
            expect(config.assetPairs).toMatchSnapshot();
        });

        it('should have empty contract addresses when not provided', () => {
            const config = buildStellarRuntimeConfig(mainnetConfig);
            expect(config.contractAddresses).toEqual({});
            expect(config.contractAddresses).toMatchSnapshot();
        });
    });

    describe('generateStellarConfigFile — stellar-dex', () => {
        it('should match snapshot for stellar-dex template', () => {
            const content = generateStellarConfigFile('stellar-dex', testnetConfig);
            expect(content).toMatchSnapshot();
        });

        it('should include network configuration', () => {
            const content = generateStellarConfigFile('stellar-dex', testnetConfig);
            expect(content).toContain('network:');
            expect(content).toContain('testnet');
            expect(content).toMatchSnapshot();
        });

        it('should include Horizon URL', () => {
            const content = generateStellarConfigFile('stellar-dex', testnetConfig);
            expect(content).toContain('horizonUrl:');
            expect(content).toContain('horizon-testnet.stellar.org');
            expect(content).toMatchSnapshot();
        });

        it('should include asset pairs for DEX template', () => {
            const content = generateStellarConfigFile('stellar-dex', testnetConfig);
            expect(content).toContain('assetPairs:');
            expect(content).toMatchSnapshot();
        });
    });

    describe('generateStellarConfigFile — soroban-defi', () => {
        it('should match snapshot for soroban-defi template', () => {
            const content = generateStellarConfigFile('soroban-defi', testnetConfig);
            expect(content).toMatchSnapshot();
        });

        it('should include Soroban RPC URL', () => {
            const content = generateStellarConfigFile('soroban-defi', testnetConfig);
            expect(content).toContain('sorobanRpcUrl:');
            expect(content).toContain('soroban-testnet.stellar.org');
            expect(content).toMatchSnapshot();
        });

        it('should include contract addresses for Soroban template', () => {
            const content = generateStellarConfigFile('soroban-defi', testnetConfig);
            expect(content).toContain('contractAddresses:');
            expect(content).toMatchSnapshot();
        });
    });

    describe('generateStellarConfigFile — asset-issuance', () => {
        it('should match snapshot for asset-issuance template', () => {
            const content = generateStellarConfigFile('asset-issuance', testnetConfig);
            expect(content).toMatchSnapshot();
        });

        it('should include contract addresses for asset-issuance template', () => {
            const content = generateStellarConfigFile('asset-issuance', testnetConfig);
            expect(content).toContain('contractAddresses:');
            expect(content).toMatchSnapshot();
        });
    });

    describe('generateStellarConfigFile — payment-gateway', () => {
        it('should match snapshot for payment-gateway template', () => {
            const content = generateStellarConfigFile('payment-gateway', testnetConfig);
            expect(content).toMatchSnapshot();
        });

        it('should not include asset pairs for payment-gateway', () => {
            const content = generateStellarConfigFile('payment-gateway', testnetConfig);
            expect(content).not.toContain('assetPairs:');
            expect(content).toMatchSnapshot();
        });
    });

    describe('formatAssetLabel', () => {
        it('should format native asset correctly', () => {
            const label = formatAssetLabel({ type: 'native' });
            expect(label).toBe('XLM (native)');
            expect(label).toMatchSnapshot();
        });

        it('should format credit asset correctly', () => {
            const label = formatAssetLabel({
                type: 'credit_alphanum12',
                code: 'USDC',
                issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            });
            expect(label).toMatchSnapshot();
            expect(label).toContain('USDC');
            expect(label).toContain('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
        });
    });

    describe('Template Feature Flags', () => {
        it('should correctly identify Soroban requirements', () => {
            expect(requiresSoroban('soroban-defi')).toBe(true);
            expect(requiresSoroban('stellar-dex')).toBe(false);
            expect(requiresSoroban('payment-gateway')).toBe(false);
            expect(requiresSoroban('asset-issuance')).toBe(false);
        });

        it('should correctly identify asset pair usage', () => {
            expect(usesAssetPairs('stellar-dex')).toBe(true);
            expect(usesAssetPairs('soroban-defi')).toBe(true);
            expect(usesAssetPairs('payment-gateway')).toBe(false);
            expect(usesAssetPairs('asset-issuance')).toBe(false);
        });

        it('should correctly identify contract address usage', () => {
            expect(usesContractAddresses('soroban-defi')).toBe(true);
            expect(usesContractAddresses('asset-issuance')).toBe(true);
            expect(usesContractAddresses('stellar-dex')).toBe(false);
            expect(usesContractAddresses('payment-gateway')).toBe(false);
        });

        it('should match snapshot for feature flag results', () => {
            const flags = {
                sorobanDefiRequiresSoroban: requiresSoroban('soroban-defi'),
                dexUsesAssetPairs: usesAssetPairs('stellar-dex'),
                sorobanDefiUsesContracts: usesContractAddresses('soroban-defi'),
            };
            expect(flags).toMatchSnapshot();
        });
    });

    describe('Configuration Serialization Stability', () => {
        it('should serialize env vars consistently', () => {
            const envVars = buildStellarEnvVars(testnetConfig);
            const serialized = JSON.stringify(envVars);
            expect(serialized).toMatchSnapshot();
        });

        it('should serialize runtime config consistently', () => {
            const config = buildStellarRuntimeConfig(testnetConfig);
            const serialized = JSON.stringify(config);
            expect(serialized).toMatchSnapshot();
        });

        it('should generate consistent file content', () => {
            const content1 = generateStellarConfigFile('stellar-dex', testnetConfig);
            const content2 = generateStellarConfigFile('stellar-dex', testnetConfig);
            expect(content1).toBe(content2);
            expect(content1).toMatchSnapshot();
        });
    });

    describe('Edge Cases', () => {
        it('should handle config with no asset pairs', () => {
            const config: StellarConfig = {
                network: 'testnet',
                horizonUrl: 'https://horizon-testnet.stellar.org',
                sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
            };
            const envVars = buildStellarEnvVars(config);
            expect(envVars.NEXT_PUBLIC_ASSET_PAIRS).toBeUndefined();
            expect(envVars).toMatchSnapshot();
        });

        it('should handle config with no contract addresses', () => {
            const config: StellarConfig = {
                network: 'testnet',
                horizonUrl: 'https://horizon-testnet.stellar.org',
                sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
            };
            const envVars = buildStellarEnvVars(config);
            expect(envVars.NEXT_PUBLIC_CONTRACT_ADDRESSES).toBeUndefined();
            expect(envVars).toMatchSnapshot();
        });

        it('should handle config with empty asset pairs array', () => {
            const config: StellarConfig = {
                network: 'testnet',
                horizonUrl: 'https://horizon-testnet.stellar.org',
                sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
                assetPairs: [],
            };
            const envVars = buildStellarEnvVars(config);
            expect(envVars.NEXT_PUBLIC_ASSET_PAIRS).toBeUndefined();
            expect(envVars).toMatchSnapshot();
        });

        it('should handle config with empty contract addresses object', () => {
            const config: StellarConfig = {
                network: 'testnet',
                horizonUrl: 'https://horizon-testnet.stellar.org',
                sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
                contractAddresses: {},
            };
            const envVars = buildStellarEnvVars(config);
            expect(envVars.NEXT_PUBLIC_CONTRACT_ADDRESSES).toBeUndefined();
            expect(envVars).toMatchSnapshot();
        });
    });
});
