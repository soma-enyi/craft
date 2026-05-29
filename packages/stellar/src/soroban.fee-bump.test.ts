/**
 * Fee Bump Transaction Builder Tests (#618)
 *
 * Tests fee calculation under low and high congestion, and fee cap enforcement.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildFeeBumpTransaction, MAX_FEE_BUMP_STROOPS } from './soroban';
import { Networks, Keypair, TransactionBuilder, BASE_FEE, Operation, Asset } from 'stellar-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NETWORK_PASSPHRASE = Networks.TESTNET;
const SOURCE_KEYPAIR = Keypair.random();
const FEE_SOURCE_KEYPAIR = Keypair.random();

/** Build a minimal signed inner transaction XDR for testing. */
function buildInnerTxXdr(): string {
    const account = {
        accountId: () => SOURCE_KEYPAIR.publicKey(),
        sequenceNumber: () => '100',
        incrementSequenceNumber: () => {},
    } as any;

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.payment({
                destination: Keypair.random().publicKey(),
                asset: Asset.native(),
                amount: '1',
            })
        )
        .setTimeout(30)
        .build();

    tx.sign(SOURCE_KEYPAIR);
    return tx.toXDR();
}

function makeMockClient(p90Fee: string) {
    return {
        getFeeStats: vi.fn().mockResolvedValue({
            sorobanInclusionFee: { p90: p90Fee },
        }),
    } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildFeeBumpTransaction', () => {
    it('calculates fee as 1.5× p90 under low congestion', async () => {
        const innerXdr = buildInnerTxXdr();
        const client = makeMockClient('200'); // low congestion: p90 = 200 stroops

        const result = await buildFeeBumpTransaction(
            innerXdr,
            FEE_SOURCE_KEYPAIR.publicKey(),
            client,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            // 200 * 1.5 = 300
            expect(result.feeCharged).toBe(300);
            expect(result.feeBumpXdr).toBeTruthy();
        }
    });

    it('calculates fee as 1.5× p90 under high congestion', async () => {
        const innerXdr = buildInnerTxXdr();
        // p90 = 7 000 000 → 7 000 000 * 1.5 = 10 500 000 → capped at MAX_FEE_BUMP_STROOPS
        const client = makeMockClient('7000000');

        const result = await buildFeeBumpTransaction(
            innerXdr,
            FEE_SOURCE_KEYPAIR.publicKey(),
            client,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.feeCharged).toBe(MAX_FEE_BUMP_STROOPS);
        }
    });

    it('enforces the maximum fee cap', async () => {
        const innerXdr = buildInnerTxXdr();
        // Extreme congestion: p90 far exceeds the cap
        const client = makeMockClient('99999999');

        const result = await buildFeeBumpTransaction(
            innerXdr,
            FEE_SOURCE_KEYPAIR.publicKey(),
            client,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.feeCharged).toBeLessThanOrEqual(MAX_FEE_BUMP_STROOPS);
        }
    });

    it('returns an error when the RPC call fails', async () => {
        const innerXdr = buildInnerTxXdr();
        const client = {
            getFeeStats: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
        } as any;

        const result = await buildFeeBumpTransaction(
            innerXdr,
            FEE_SOURCE_KEYPAIR.publicKey(),
            client,
        );

        expect(result.ok).toBe(false);
    });

    it('falls back to BASE_FEE when fee stats are missing', async () => {
        const innerXdr = buildInnerTxXdr();
        const client = {
            getFeeStats: vi.fn().mockResolvedValue({}), // no fee stats
        } as any;

        const result = await buildFeeBumpTransaction(
            innerXdr,
            FEE_SOURCE_KEYPAIR.publicKey(),
            client,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            // BASE_FEE (100) * 1.5 = 150
            expect(result.feeCharged).toBe(150);
        }
    });
});
