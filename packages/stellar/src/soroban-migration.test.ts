/**
 * Soroban Cross-Network Migration Tests (#617)
 *
 * Tests rejection of testnet parameters on mainnet and the full promotion
 * flow with valid mainnet config.
 */

import { describe, it, expect } from 'vitest';
import { Networks, Keypair } from 'stellar-sdk';
import {
    migrateSorobanContract,
    detectTestnetParameters,
} from './soroban-migration';
import { NETWORK_PASSPHRASES, HORIZON_URLS, SOROBAN_RPC_URLS } from './config';

const MAINNET_CONFIG = {
    network: 'mainnet' as const,
    horizonUrl: HORIZON_URLS.mainnet,
    networkPassphrase: NETWORK_PASSPHRASES.mainnet,
    sorobanRpcUrl: SOROBAN_RPC_URLS.mainnet,
};

const TESTNET_CONFIG = {
    network: 'testnet' as const,
    horizonUrl: HORIZON_URLS.testnet,
    networkPassphrase: NETWORK_PASSPHRASES.testnet,
    sorobanRpcUrl: SOROBAN_RPC_URLS.testnet,
};

const DUMMY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const SOURCE_KEY = Keypair.random().publicKey();

// ---------------------------------------------------------------------------
// detectTestnetParameters
// ---------------------------------------------------------------------------

describe('detectTestnetParameters', () => {
    it('returns null for a valid mainnet config', () => {
        expect(detectTestnetParameters(MAINNET_CONFIG)).toBeNull();
    });

    it('detects testnet network passphrase', () => {
        const cfg = { ...MAINNET_CONFIG, networkPassphrase: NETWORK_PASSPHRASES.testnet };
        expect(detectTestnetParameters(cfg)).toContain('networkPassphrase');
    });

    it('detects testnet horizonUrl', () => {
        const cfg = { ...MAINNET_CONFIG, horizonUrl: HORIZON_URLS.testnet };
        expect(detectTestnetParameters(cfg)).toContain('horizonUrl');
    });

    it('detects testnet sorobanRpcUrl', () => {
        const cfg = { ...MAINNET_CONFIG, sorobanRpcUrl: SOROBAN_RPC_URLS.testnet };
        expect(detectTestnetParameters(cfg)).toContain('sorobanRpcUrl');
    });

    it('detects "testnet" as the network value', () => {
        const cfg = { ...MAINNET_CONFIG, network: 'testnet' as const };
        expect(detectTestnetParameters(cfg)).toContain('network');
    });
});

// ---------------------------------------------------------------------------
// migrateSorobanContract
// ---------------------------------------------------------------------------

describe('migrateSorobanContract – mainnet promotion', () => {
    it('rejects when confirm is omitted', () => {
        const result = migrateSorobanContract({
            wasmBinary: DUMMY_WASM,
            sourcePublicKey: SOURCE_KEY,
            config: MAINNET_CONFIG,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('explicit confirmation');
    });

    it('rejects when confirm is false', () => {
        const result = migrateSorobanContract({
            wasmBinary: DUMMY_WASM,
            sourcePublicKey: SOURCE_KEY,
            config: MAINNET_CONFIG,
            confirm: false,
        });
        expect(result.ok).toBe(false);
    });

    it('rejects testnet passphrase on mainnet even with confirm', () => {
        const result = migrateSorobanContract({
            wasmBinary: DUMMY_WASM,
            sourcePublicKey: SOURCE_KEY,
            config: { ...MAINNET_CONFIG, networkPassphrase: Networks.TESTNET },
            confirm: true,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('networkPassphrase');
    });

    it('rejects testnet horizonUrl on mainnet even with confirm', () => {
        const result = migrateSorobanContract({
            wasmBinary: DUMMY_WASM,
            sourcePublicKey: SOURCE_KEY,
            config: { ...MAINNET_CONFIG, horizonUrl: HORIZON_URLS.testnet },
            confirm: true,
        });
        expect(result.ok).toBe(false);
    });

    it('succeeds with valid mainnet config and confirm: true', () => {
        const result = migrateSorobanContract({
            wasmBinary: DUMMY_WASM,
            sourcePublicKey: SOURCE_KEY,
            config: MAINNET_CONFIG,
            confirm: true,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.network).toBe('mainnet');
            expect(result.message).toContain('mainnet');
        }
    });
});

describe('migrateSorobanContract – testnet flow', () => {
    it('succeeds on testnet without requiring confirm', () => {
        const result = migrateSorobanContract({
            wasmBinary: DUMMY_WASM,
            sourcePublicKey: SOURCE_KEY,
            config: TESTNET_CONFIG,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.network).toBe('testnet');
    });
});
