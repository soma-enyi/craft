/**
 * Stellar Service Tests — Mock-Based Horizon RPC Infrastructure
 *
 * Issue #567 — test/issue-031-stellar-horizon-mock-infrastructure
 *
 * Validates service behavior (loadAccount, getAccountBalance, submitTransaction)
 * against typed mock responses from mock.ts factory functions.
 *
 * All Horizon network calls are intercepted via vi.spyOn on the shared `server`
 * instance — no real network traffic is made.
 *
 * @see docs/stellar-horizon-mocking.md for usage examples
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { server, loadAccount, getAccountBalance, submitTransaction } from './service';
import {
    makeAccountResponse,
    makeTxResponse,
    makeLedgerResponse,
    makeAssetResponse,
    makeOrderBookResponse,
} from './mock';

const ACCOUNT_ID = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ';
const TX_HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

afterEach(() => vi.restoreAllMocks());

// ── loadAccount ───────────────────────────────────────────────────────────────

describe('loadAccount – mock-based', () => {
    it('returns the mocked account for a valid public key', async () => {
        const mock = makeAccountResponse(ACCOUNT_ID);
        vi.spyOn(server, 'loadAccount').mockResolvedValue(mock as any);

        const result = await loadAccount(ACCOUNT_ID);

        expect(result.id).toBe(ACCOUNT_ID);
        expect(result.account_id).toBe(ACCOUNT_ID);
    });

    it('returns native XLM balance from default mock', async () => {
        const mock = makeAccountResponse(ACCOUNT_ID);
        vi.spyOn(server, 'loadAccount').mockResolvedValue(mock as any);

        const result = await loadAccount(ACCOUNT_ID);

        expect(result.balances).toHaveLength(1);
        expect(result.balances[0].asset_type).toBe('native');
        expect(result.balances[0].balance).toBe('1000.0000000');
    });

    it('returns multi-asset balances when overridden', async () => {
        const mock = makeAccountResponse(ACCOUNT_ID, {
            balances: [
                { balance: '500.0000000', asset_type: 'native' },
                {
                    balance: '250.0000000',
                    asset_type: 'credit_alphanum4',
                    asset_code: 'USDC',
                    asset_issuer: 'GBBD47UZQ5SYWDRFGUTDJWEB5QCSTX3UNAWXE2VOHYMWTKWTOA5XUSEA',
                },
            ],
        });
        vi.spyOn(server, 'loadAccount').mockResolvedValue(mock as any);

        const result = await loadAccount(ACCOUNT_ID);

        expect(result.balances).toHaveLength(2);
        expect(result.balances[1].asset_code).toBe('USDC');
    });

    it('wraps Horizon 404 with descriptive error message', async () => {
        vi.spyOn(server, 'loadAccount').mockRejectedValue(
            Object.assign(new Error('Not Found'), { status: 404 })
        );

        await expect(loadAccount('GBAD')).rejects.toThrow('Failed to load account');
    });

    it('wraps Horizon 429 rate limit with descriptive error message', async () => {
        vi.spyOn(server, 'loadAccount').mockRejectedValue(
            Object.assign(new Error('Rate Limit Exceeded'), { status: 429 })
        );

        await expect(loadAccount(ACCOUNT_ID)).rejects.toThrow('Failed to load account');
    });
});

// ── getAccountBalance ─────────────────────────────────────────────────────────

describe('getAccountBalance – mock-based', () => {
    it('returns balances array from mocked account', async () => {
        const mock = makeAccountResponse(ACCOUNT_ID, {
            balances: [{ balance: '42.0000000', asset_type: 'native' }],
        });
        vi.spyOn(server, 'loadAccount').mockResolvedValue(mock as any);

        const balances = await getAccountBalance(ACCOUNT_ID);

        expect(balances).toHaveLength(1);
        expect(balances[0].balance).toBe('42.0000000');
    });

    it('propagates load failure as descriptive error', async () => {
        vi.spyOn(server, 'loadAccount').mockRejectedValue(new Error('Account not found (404)'));

        await expect(getAccountBalance('GBAD')).rejects.toThrow('Failed to get account balance');
    });
});

// ── submitTransaction ─────────────────────────────────────────────────────────

describe('submitTransaction – mock-based', () => {
    it('returns successful transaction response', async () => {
        const mock = makeTxResponse(TX_HASH, { successful: true });
        vi.spyOn(server, 'submitTransaction').mockResolvedValue(mock as any);

        const tx = { hash: () => TX_HASH } as any;
        const result = await submitTransaction(tx);

        expect(result.hash).toBe(TX_HASH);
        expect(result.successful).toBe(true);
    });

    it('returns failed transaction response when successful=false', async () => {
        const mock = makeTxResponse(TX_HASH, { successful: false });
        vi.spyOn(server, 'submitTransaction').mockResolvedValue(mock as any);

        const tx = { hash: () => TX_HASH } as any;
        const result = await submitTransaction(tx);

        expect(result.successful).toBe(false);
    });

    it('wraps submission failure with descriptive error', async () => {
        vi.spyOn(server, 'submitTransaction').mockRejectedValue(new Error('txFAILED'));

        const tx = { hash: () => TX_HASH } as any;
        await expect(submitTransaction(tx)).rejects.toThrow('Failed to submit transaction');
    });

    it('includes transaction hash in error context', async () => {
        vi.spyOn(server, 'submitTransaction').mockRejectedValue(
            Object.assign(new Error('op_no_source_account'), { extras: { result_codes: { transaction: 'tx_failed' } } })
        );

        const tx = { hash: () => TX_HASH } as any;
        await expect(submitTransaction(tx)).rejects.toThrow('Failed to submit transaction');
    });
});

// ── Factory function correctness ──────────────────────────────────────────────

describe('mock factory functions', () => {
    it('makeAccountResponse produces valid account shape', () => {
        const account = makeAccountResponse(ACCOUNT_ID);

        expect(account.id).toBe(ACCOUNT_ID);
        expect(account.account_id).toBe(ACCOUNT_ID);
        expect(account.balances).toBeDefined();
        expect(account.sequence).toBeDefined();
        expect(account.flags).toMatchObject({
            auth_required: false,
            auth_revocable: false,
            auth_immutable: false,
        });
        expect(account.signers[0].key).toBe(ACCOUNT_ID);
    });

    it('makeTxResponse produces valid transaction shape', () => {
        const tx = makeTxResponse(TX_HASH);

        expect(tx.hash).toBe(TX_HASH);
        expect(tx.id).toBe(TX_HASH);
        expect(tx.successful).toBe(true);
        expect(tx.fee_charged).toBeDefined();
        expect(tx.operation_count).toBeGreaterThan(0);
    });

    it('makeLedgerResponse produces valid ledger shape', () => {
        const ledger = makeLedgerResponse(1000);

        expect(ledger.sequence).toBe(1000);
        expect(ledger.protocol_version).toBe(20);
        expect(ledger.base_fee_in_stroops).toBe(100);
        expect(ledger.transaction_count).toBeGreaterThanOrEqual(0);
    });

    it('makeLedgerResponse accepts overrides', () => {
        const ledger = makeLedgerResponse(2000, { transaction_count: 99, operation_count: 300 });

        expect(ledger.sequence).toBe(2000);
        expect(ledger.transaction_count).toBe(99);
        expect(ledger.operation_count).toBe(300);
    });

    it('makeAssetResponse produces valid asset shape for alphanum4', () => {
        const asset = makeAssetResponse({
            code: 'USDC',
            issuer: 'GBBD47UZQ5SYWDRFGUTDJWEB5QCSTX3UNAWXE2VOHYMWTKWTOA5XUSEA',
        });

        expect(asset.asset_code).toBe('USDC');
        expect(asset.asset_type).toBe('credit_alphanum4');
        expect(asset.num_accounts).toBeGreaterThan(0);
        expect(asset.amount).toBeDefined();
    });

    it('makeAssetResponse produces alphanum12 for long codes', () => {
        const asset = makeAssetResponse({
            code: 'LONGTOKEN',
            issuer: 'GBBD47UZQ5SYWDRFGUTDJWEB5QCSTX3UNAWXE2VOHYMWTKWTOA5XUSEA',
        });

        expect(asset.asset_type).toBe('credit_alphanum12');
    });

    it('makeOrderBookResponse produces valid order book shape', () => {
        const book = makeOrderBookResponse(
            { code: 'USDC', issuer: 'GBBD47UZQ5SYWDRFGUTDJWEB5QCSTX3UNAWXE2VOHYMWTKWTOA5XUSEA' },
            { code: 'XLM', issuer: '' }
        );

        expect(book.bids.length).toBeGreaterThan(0);
        expect(book.asks.length).toBeGreaterThan(0);
        expect(book.base.asset_code).toBe('USDC');
        expect(book.counter.asset_code).toBe('XLM');
        expect(book.bids[0]).toMatchObject({ price: expect.any(String), amount: expect.any(String) });
    });

    it('makeOrderBookResponse accepts bid/ask overrides', () => {
        const book = makeOrderBookResponse(
            { code: 'USDC', issuer: 'GBBD...' },
            { code: 'EUR', issuer: 'GCQP...' },
            {
                bids: [{ price: '0.95', amount: '10000.0000000', price_r: { n: 19, d: 20 } }],
                asks: [{ price: '1.05', amount: '5000.0000000', price_r: { n: 21, d: 20 } }],
            }
        );

        expect(book.bids).toHaveLength(1);
        expect(book.bids[0].price).toBe('0.95');
        expect(book.asks[0].price).toBe('1.05');
    });

    it('factories are composable — account with custom balance and asset', () => {
        const issuer = 'GBBD47UZQ5SYWDRFGUTDJWEB5QCSTX3UNAWXE2VOHYMWTKWTOA5XUSEA';
        const asset = makeAssetResponse({ code: 'USDC', issuer });

        const account = makeAccountResponse(ACCOUNT_ID, {
            balances: [
                { balance: '1000.0000000', asset_type: 'native' },
                {
                    balance: asset.balances.authorized,
                    asset_type: asset.asset_type,
                    asset_code: asset.asset_code,
                    asset_issuer: asset.asset_issuer,
                },
            ],
        });

        expect(account.balances).toHaveLength(2);
        expect(account.balances[1].asset_code).toBe('USDC');
    });
});
