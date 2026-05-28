import { SorobanRpc, Contract, TransactionBuilder, Networks, BASE_FEE, xdr, hash, StrKey } from 'stellar-sdk';
import { config } from './config';
import { parseStellarError } from './errors';

// Minimal AppError shape — matches apps/backend/src/lib/api/retryable-error.ts
export interface AppError {
    status?: number;
    message: string;
    code?: string;
}

export type InvokeContractResult<T = SorobanRpc.Api.SimulateTransactionResponse> =
    | { ok: true; result: T }
    | { ok: false; error: AppError };

/**
 * Maximum Soroban contract WASM binary size in bytes.
 * Based on Soroban network deployment constraints.
 * @see https://developers.stellar.org/docs/smart-contracts/limits-and-fees
 */
export const MAX_WASM_SIZE_BYTES = 65536; // 64 KB

export interface WasmValidationResult {
    valid: boolean;
    size?: number;
    maxSize: number;
    error?: string;
}

const SOROBAN_RPC_URLS = {
    mainnet: 'https://soroban-mainnet.stellar.org',
    testnet: 'https://soroban-testnet.stellar.org',
} as const;

function getSorobanRpcUrl(): string {
    return (
        process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
        SOROBAN_RPC_URLS[config.stellar.network]
    );
}

function getNetworkPassphrase(): string {
    return config.stellar.network === 'mainnet'
        ? Networks.PUBLIC
        : Networks.TESTNET;
}

/**
 * Creates a Soroban RPC server instance for the configured network.
 */
export function createSorobanClient(): SorobanRpc.Server {
    return new SorobanRpc.Server(getSorobanRpcUrl(), { allowHttp: false });
}

export const sorobanClient = createSorobanClient();

// ---------------------------------------------------------------------------
// Contract State Simulation Cache
// ---------------------------------------------------------------------------
//
// A short-lived in-memory cache for `simulateContractCall` results.
//
// Design notes:
//  - Key  : `${contractId}:${method}:${JSON.stringify(args)}:${sourcePublicKey}`
//  - TTL  : CACHE_TTL_MS (default 5 000 ms). Entries older than this are
//           considered stale and bypassed on the next read.
//  - Size : MAX_CACHE_ENTRIES (default 1 000). When the limit is reached the
//           oldest entry (first inserted, because Map preserves insertion
//           order) is evicted before a new entry is stored.
//  - Eviction is lazy – stale entries are only removed when they are accessed
//           or when a new entry would exceed MAX_CACHE_ENTRIES.
//
// Call `clearCache()` to flush all entries (e.g. in test teardown).
// ---------------------------------------------------------------------------

/** Maximum number of entries held at once. Older entries are evicted first. */
const MAX_CACHE_ENTRIES = 1_000;

/** Time-to-live for each cache entry in milliseconds. */
const CACHE_TTL_MS = 5_000;

interface SimulationCacheEntry {
    response: SorobanRpc.Api.SimulateTransactionResponse;
    /** Unix timestamp (ms) of when the entry was stored. */
    storedAt: number;
}

const simulationCache = new Map<string, SimulationCacheEntry>();

/** Build the cache key from the call parameters. */
function buildCacheKey(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string
): string {
    // Serialise args to their base64 XDR representations for a stable key.
    const argsKey = args.map((a) => a.toXDR('base64')).join(',');
    return `${contractId}:${method}:${argsKey}:${sourcePublicKey}`;
}

/**
 * Evict a single entry by key if it exists – used when making room for a new
 * entry that would exceed the size cap.
 */
function evictOldest(): void {
    const firstKey = simulationCache.keys().next().value;
    if (firstKey !== undefined) {
        simulationCache.delete(firstKey);
    }
}

/**
 * Clear all cached simulation results.
 * Call this in test teardown to ensure isolation between test cases.
 */
export function clearCache(): void {
    simulationCache.clear();
}

/**
 * Simulates a contract invocation without submitting to the network.
 *
 * Results are cached for CACHE_TTL_MS to avoid redundant RPC round-trips
 * during the preview and deployment flows. The cache is keyed on
 * (contractId, method, args, sourcePublicKey).
 *
 * @param contractId - The contract address (C...)
 * @param method - The contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - The source account public key
 */
export async function simulateContractCall(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string
): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    const cacheKey = buildCacheKey(contractId, method, args, sourcePublicKey);
    const now = Date.now();

    // Cache hit – return the stored response if still within TTL.
    const cached = simulationCache.get(cacheKey);
    if (cached && now - cached.storedAt < CACHE_TTL_MS) {
        return cached.response;
    }

    // Cache miss (or stale) – fetch from RPC.
    const account = await sorobanClient.getAccount(sourcePublicKey);
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

    const response = await sorobanClient.simulateTransaction(tx);

    // Evict the oldest entry first if we are at capacity.
    if (simulationCache.size >= MAX_CACHE_ENTRIES) {
        evictOldest();
    }

    simulationCache.set(cacheKey, { response, storedAt: now });
    return response;
}

/**
 * Performs a dry-run simulation of a Soroban contract invocation.
 * Detects errors and estimates resources before actual deployment.
 *
 * @param contractId - The contract address (C...)
 * @param method - The contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - The source account public key
 * @returns Simulation result with success status, errors, and resource estimates
 *
 * @example
 * ```typescript
 * const dryRun = await performContractDryRun(contractId, 'transfer', args, pubKey);
 * if (!dryRun.success) {
 *   console.error('Simulation failed:', dryRun.error);
 *   return; // Block deployment
 * }
 * console.log('Estimated fee:', dryRun.resourceEstimate?.fee);
 * ```
 */
export async function performContractDryRun(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string
): Promise<{
    success: boolean;
    error?: string;
    resourceEstimate?: {
        cpuInstructions?: string;
        memoryBytes?: string;
        fee?: string;
    };
    result?: SorobanRpc.Api.SimulateTransactionResponse;
}> {
    try {
        const simulation = await simulateContractCall(
            contractId,
            method,
            args,
            sourcePublicKey
        );

        // Check for simulation errors
        if (SorobanRpc.Api.isSimulationError(simulation)) {
            return {
                success: false,
                error: `Contract simulation failed: ${simulation.error}`,
                result: simulation,
            };
        }

        // Extract resource estimates if available
        const resourceEstimate: any = {};
        if ('cost' in simulation && simulation.cost) {
            resourceEstimate.cpuInstructions = simulation.cost.cpuInsns;
            resourceEstimate.memoryBytes = simulation.cost.memBytes;
        }
        if ('minResourceFee' in simulation) {
            resourceEstimate.fee = simulation.minResourceFee;
        }

        return {
            success: true,
            resourceEstimate,
            result: simulation,
        };
    } catch (error: unknown) {
        const parsed = parseStellarError(error);
        return {
            success: false,
            error: `Dry-run failed: ${parsed.message}`,
        };
    }
}

/**
 * Prepares and submits a contract invocation transaction.
 * Caller is responsible for signing the prepared transaction before submission.
 *
 * @param contractId - The contract address (C...)
 * @param method - The contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - The source account public key
 * @returns The prepared (unsigned) transaction ready for signing
 */
export async function prepareContractCall(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string
): Promise<ReturnType<typeof TransactionBuilder.prototype.build>> {
    const account = await sorobanClient.getAccount(sourcePublicKey);
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

    return sorobanClient.prepareTransaction(tx);
}

/**
 * Sends a signed transaction to the Soroban RPC and polls for the result.
 *
 * @param signedTxXdr - The signed transaction in XDR format
 */
export async function sendSorobanTransaction(
    signedTxXdr: string
): Promise<SorobanRpc.Api.GetTransactionResponse> {
    const tx = TransactionBuilder.fromXDR(signedTxXdr, getNetworkPassphrase());
    const sendResult = await sorobanClient.sendTransaction(tx);

    if (sendResult.status === 'ERROR') {
        throw new Error(`Transaction submission failed: ${sendResult.errorResult?.toXDR('base64')}`);
    }

    // Poll for transaction result
    let getResult = await sorobanClient.getTransaction(sendResult.hash);
    const deadline = Date.now() + 30_000;

    while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (Date.now() > deadline) {
            throw new Error(`Transaction ${sendResult.hash} not found after 30s`);
        }
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await sorobanClient.getTransaction(sendResult.hash);
    }

    return getResult;
}

/**
 * Invoke a Soroban contract method via simulation and return a typed result.
 *
 * Wraps `simulateContractCall` and maps any RPC error through `parseStellarError`
 * so callers receive a discriminated union instead of a raw thrown error.
 *
 * @param contractId - The contract address (C...)
 * @param method - The contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - The source account public key
 * @param _simulate - Optional override for `simulateContractCall` (for testing)
 * @returns `{ ok: true, result }` on success or `{ ok: false, error: AppError }` on failure
 *
 * @example
 * ```typescript
 * const res = await invokeContractMethod(contractId, 'transfer', args, pubKey);
 * if (!res.ok) {
 *   console.error(res.error.message); // typed, user-friendly message
 * }
 * ```
 */
export async function invokeContractMethod(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string,
    _simulate: typeof simulateContractCall = simulateContractCall,
): Promise<InvokeContractResult> {
    try {
        const result = await _simulate(contractId, method, args, sourcePublicKey);
        return { ok: true, result };
    } catch (raw: unknown) {
        const parsed = parseStellarError(raw);
        return {
            ok: false,
            error: {
                message: parsed.message,
                code: parsed.code,
                // Map retryable network/rate-limit errors to an HTTP-like status
                // so callers using isRetryableError(AppError) work correctly.
                status: parsed.retryable && parsed.code === 'RATE_LIMITED' ? 429
                    : parsed.retryable && parsed.code === 'CONNECTION_TIMEOUT' ? undefined
                    : parsed.retryable ? undefined
                    : 400,
            },
        };
    }
}

/**
 * Validates Soroban contract WASM binary size against network deployment constraints.
 *
 * @param wasmBinary - The WASM binary as Buffer or Uint8Array
 * @returns Validation result with size information and error details
 *
 * @example
 * ```typescript
 * const wasm = fs.readFileSync('contract.wasm');
 * const result = validateWasmSize(wasm);
 * if (!result.valid) {
 *   console.error(result.error);
 *   console.log(`Binary size: ${result.size} bytes, Max: ${result.maxSize} bytes`);
 * }
 * ```
 */
export function validateWasmSize(wasmBinary: Buffer | Uint8Array): WasmValidationResult {
    const size = wasmBinary.length;

    if (size > MAX_WASM_SIZE_BYTES) {
        return {
            valid: false,
            size,
            maxSize: MAX_WASM_SIZE_BYTES,
            error: `WASM binary size (${size} bytes) exceeds maximum allowed size (${MAX_WASM_SIZE_BYTES} bytes). Reduce contract size by ${size - MAX_WASM_SIZE_BYTES} bytes.`,
        };
    }

    return {
        valid: true,
        size,
        maxSize: MAX_WASM_SIZE_BYTES,
    };
}

/**
 * Validates WASM binary before deployment and throws if invalid.
 *
 * @param wasmBinary - The WASM binary to validate
 * @throws Error if WASM binary exceeds size limit
 *
 * @example
 * ```typescript
 * try {
 *   assertValidWasmSize(wasmBinary);
 *   // Proceed with deployment
 * } catch (error) {
 *   console.error('Deployment blocked:', error.message);
 * }
 * ```
 */
export function assertValidWasmSize(wasmBinary: Buffer | Uint8Array): void {
    const result = validateWasmSize(wasmBinary);
    if (!result.valid) {
        throw new Error(result.error);
    }
}
