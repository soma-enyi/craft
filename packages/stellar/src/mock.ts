/**
 * Stellar Horizon Mock Infrastructure
 *
 * Issue #567 — test/issue-031-stellar-horizon-mock-infrastructure
 *
 * Extends the existing MockHorizon class with typed factory functions for
 * all Horizon endpoints used in production code:
 *   - Account (loadAccount / getAccountBalance)
 *   - Transaction (submitTransaction)
 *   - Ledger
 *   - Asset
 *   - OrderBook
 *
 * All factories are typed against packages/types/src/stellar.ts and the
 * existing HorizonAccount / HorizonTransaction / HorizonLedger interfaces
 * from tests/mocks/stellar-horizon.mock.ts.
 *
 * Usage:
 *   import { makeAccountResponse, makeTxResponse, makeLedgerResponse } from './mock';
 *   vi.spyOn(server, 'loadAccount').mockResolvedValue(makeAccountResponse('GABC'));
 *
 * @see docs/stellar-horizon-mocking.md
 */

import type {
    HorizonAccount,
    HorizonTransaction,
    HorizonLedger,
    HorizonAsset,
    HorizonOrderBook,
} from '../../apps/backend/tests/mocks/stellar-horizon.mock';
import type { StellarAsset } from '@craft/types';

// ── Re-export existing mock utilities ─────────────────────────────────────────

export { mockAccount, mockTransaction } from './mock';

// ── Typed factory functions ───────────────────────────────────────────────────

/**
 * Build a realistic Horizon account response.
 *
 * @param accountId - Stellar public key (G...)
 * @param overrides - Partial fields to override defaults
 *
 * @example
 * vi.spyOn(server, 'loadAccount').mockResolvedValue(
 *   makeAccountResponse('GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ')
 * );
 */
export function makeAccountResponse(
    accountId: string,
    overrides?: Partial<HorizonAccount>
): HorizonAccount {
    return {
        id: accountId,
        account_id: accountId,
        balances: [{ balance: '1000.0000000', asset_type: 'native' }],
        sequence: '1',
        subentry_count: 0,
        last_modified_ledger: 1000,
        last_modified_time: new Date().toISOString(),
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [{ weight: 1, key: accountId, type: 'ed25519_public_key' }],
        data: {},
        _links: {
            self: { href: `https://horizon.stellar.org/accounts/${accountId}` },
            transactions: { href: `https://horizon.stellar.org/accounts/${accountId}/transactions` },
            operations: { href: `https://horizon.stellar.org/accounts/${accountId}/operations` },
        },
        ...overrides,
    };
}

/**
 * Build a realistic Horizon transaction response.
 *
 * @param hash - Transaction hash (hex string)
 * @param overrides - Partial fields to override defaults
 *
 * @example
 * vi.spyOn(server, 'submitTransaction').mockResolvedValue(
 *   makeTxResponse('abc123def456', { successful: true })
 * );
 */
export function makeTxResponse(
    hash: string,
    overrides?: Partial<HorizonTransaction>
): HorizonTransaction {
    return {
        id: hash,
        paging_token: `${Date.now()}-0`,
        hash,
        ledger: 1000,
        created_at: new Date().toISOString(),
        source_account: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ',
        source_account_sequence: '1',
        fee_charged: '100',
        max_fee: '100',
        operation_count: 1,
        envelope_xdr: 'AAAAAgAAAABb8PsSeJ2XH7dDrHV6I90DH2eDBFezq92rLvdUesFGzgAAAGQADKQ7',
        result_xdr: 'AAAAAAAAAGQAAAAAAAAAAA==',
        result_meta_xdr: 'AAAAAgAAAAA=',
        successful: true,
        _links: {
            self: { href: `https://horizon.stellar.org/transactions/${hash}` },
            account: { href: `https://horizon.stellar.org/accounts/GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ` },
        },
        ...overrides,
    };
}

/**
 * Build a realistic Horizon ledger response.
 *
 * @param sequence - Ledger sequence number
 * @param overrides - Partial fields to override defaults
 *
 * @example
 * const ledger = makeLedgerResponse(1000, { transaction_count: 42 });
 */
export function makeLedgerResponse(
    sequence: number,
    overrides?: Partial<HorizonLedger>
): HorizonLedger {
    return {
        id: `${sequence}`,
        paging_token: `${sequence}`,
        sequence,
        hash: `${'0'.repeat(63)}${sequence}`,
        prev_hash: `${'0'.repeat(63)}${sequence - 1}`,
        timestamp: new Date().toISOString(),
        transaction_count: 10,
        operation_count: 50,
        closed_at: new Date().toISOString(),
        total_coins: '50000000000.0000000',
        fee_pool: '1000.0000000',
        base_fee_in_stroops: 100,
        base_reserve_in_stroops: 5_000_000,
        max_tx_set_size: 1000,
        protocol_version: 20,
        _links: {
            self: { href: `https://horizon.stellar.org/ledgers/${sequence}` },
            transactions: { href: `https://horizon.stellar.org/ledgers/${sequence}/transactions` },
        },
        ...overrides,
    };
}

/**
 * Build a realistic Horizon asset response.
 *
 * @param asset - StellarAsset (code + issuer)
 * @param overrides - Partial fields to override defaults
 *
 * @example
 * const usdc = makeAssetResponse({ code: 'USDC', issuer: 'GBBD...', type: 'credit_alphanum4' });
 */
export function makeAssetResponse(
    asset: Pick<StellarAsset, 'code' | 'issuer'>,
    overrides?: Partial<HorizonAsset>
): HorizonAsset {
    return {
        asset_type: asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
        asset_code: asset.code,
        asset_issuer: asset.issuer,
        paging_token: `${asset.code}:${asset.issuer}`,
        accounts: {
            authorized: 1000,
            authorized_to_maintain_liabilities: 100,
            unauthorized: 10,
        },
        balances: {
            authorized: '1000000.0000000',
            authorized_to_maintain_liabilities: '100000.0000000',
            unauthorized: '0.0000000',
        },
        clawback_enabled: false,
        num_accounts: 1110,
        num_claimable_balances: 50,
        num_liquidity_pools: 10,
        num_trustlines: 1110,
        amount: '1100000.0000000',
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        _links: {
            self: { href: `https://horizon.stellar.org/assets?asset_code=${asset.code}&asset_issuer=${asset.issuer}` },
        },
        ...overrides,
    };
}

/**
 * Build a realistic Horizon order book response.
 *
 * @param base - Base asset (code + issuer)
 * @param counter - Counter asset (code + issuer)
 * @param overrides - Partial fields to override defaults
 *
 * @example
 * const book = makeOrderBookResponse(
 *   { code: 'USDC', issuer: 'GBBD...' },
 *   { code: 'XLM', issuer: '' }
 * );
 */
export function makeOrderBookResponse(
    base: Pick<StellarAsset, 'code' | 'issuer'>,
    counter: Pick<StellarAsset, 'code' | 'issuer'>,
    overrides?: Partial<HorizonOrderBook>
): HorizonOrderBook {
    return {
        bids: [
            { price: '0.5000000', amount: '1000.0000000', price_r: { n: 1, d: 2 } },
            { price: '0.4500000', amount: '2000.0000000', price_r: { n: 9, d: 20 } },
        ],
        asks: [
            { price: '0.5500000', amount: '1500.0000000', price_r: { n: 11, d: 20 } },
            { price: '0.6000000', amount: '2500.0000000', price_r: { n: 3, d: 5 } },
        ],
        base: {
            asset_type: base.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
            asset_code: base.code,
            asset_issuer: base.issuer,
        },
        counter: {
            asset_type: counter.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
            asset_code: counter.code,
            asset_issuer: counter.issuer,
        },
        ...overrides,
    };
}
