/**
 * Soroban Contract Cross-Network Migration (#617)
 *
 * Safely promotes Soroban contracts from testnet to mainnet by validating
 * network-specific configuration and requiring explicit confirmation.
 *
 * ## Safety guarantees
 * - Testnet-only parameters are rejected before any mainnet operation.
 * - Mainnet promotion requires `confirm: true` from the caller.
 * - The network passphrase is validated against the target network.
 */

import { Networks } from 'stellar-sdk';
import { NETWORK_PASSPHRASES, HORIZON_URLS, SOROBAN_RPC_URLS } from './config';
import type { StellarNetworkConfig } from '@craft/types';

export type MigrationNetwork = 'mainnet' | 'testnet';

export interface MigrationConfig {
    /** WASM binary of the contract to deploy. */
    wasmBinary: Buffer | Uint8Array;
    /** Source account public key that will pay for deployment. */
    sourcePublicKey: string;
    /** Target network configuration. */
    config: StellarNetworkConfig;
    /**
     * Must be `true` to proceed with mainnet promotion.
     * Omitting or setting to `false` returns an error without touching the network.
     */
    confirm?: boolean;
}

export type MigrationResult =
    | { ok: true; network: MigrationNetwork; message: string }
    | { ok: false; error: string };

/** Testnet-only values that must not appear in a mainnet config. */
const TESTNET_ONLY_VALUES: ReadonlySet<string> = new Set([
    NETWORK_PASSPHRASES.testnet,
    HORIZON_URLS.testnet,
    SOROBAN_RPC_URLS.testnet,
    'testnet',
]);

/**
 * Validates that the provided config contains no testnet-only parameters
 * when the target network is mainnet.
 *
 * @returns An error message if a testnet parameter is detected, otherwise null.
 */
export function detectTestnetParameters(cfg: StellarNetworkConfig): string | null {
    const checks: Array<[string, string]> = [
        ['networkPassphrase', cfg.networkPassphrase],
        ['horizonUrl', cfg.horizonUrl],
        ['sorobanRpcUrl', cfg.sorobanRpcUrl ?? ''],
        ['network', cfg.network],
    ];

    for (const [field, value] of checks) {
        if (TESTNET_ONLY_VALUES.has(value)) {
            return `Testnet-only parameter detected in field "${field}": "${value}". ` +
                'Mainnet deployments must use mainnet-appropriate configuration.';
        }
    }

    return null;
}

/**
 * Promotes a Soroban contract from testnet to mainnet.
 *
 * Steps:
 * 1. Require explicit confirmation (`confirm: true`).
 * 2. Reject any testnet-only parameters in the provided config.
 * 3. Validate the network passphrase matches mainnet.
 * 4. Return success — actual deployment is handled by the caller using
 *    the validated config (keeps this function pure and testable).
 *
 * @param options - Migration configuration including WASM, source key, and target config.
 */
export function migrateSorobanContract(options: MigrationConfig): MigrationResult {
    const { config, confirm } = options;
    const targetNetwork = config.network as MigrationNetwork;

    // Step 1: Require explicit confirmation for mainnet.
    if (targetNetwork === 'mainnet' && !confirm) {
        return {
            ok: false,
            error: 'Mainnet promotion requires explicit confirmation. Pass { confirm: true } to proceed.',
        };
    }

    // Step 2: Reject testnet-only parameters on mainnet.
    if (targetNetwork === 'mainnet') {
        const paramError = detectTestnetParameters(config);
        if (paramError) {
            return { ok: false, error: paramError };
        }
    }

    // Step 3: Validate network passphrase matches the target network.
    const expectedPassphrase = NETWORK_PASSPHRASES[targetNetwork];
    if (config.networkPassphrase !== expectedPassphrase) {
        return {
            ok: false,
            error: `Network passphrase mismatch: expected "${expectedPassphrase}" for ${targetNetwork}, ` +
                `got "${config.networkPassphrase}".`,
        };
    }

    return {
        ok: true,
        network: targetNetwork,
        message: `Configuration validated for ${targetNetwork} deployment. Proceed with contract upload.`,
    };
}
