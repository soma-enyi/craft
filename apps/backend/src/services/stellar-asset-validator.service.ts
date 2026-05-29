/**
 * StellarAssetValidator
 *
 * Validates Stellar asset codes and issuer addresses, and optionally checks
 * asset existence on the Horizon API.
 *
 * Feature: stellar-asset-validation
 * Issue: #246
 */

export interface AssetValidationResult {
    valid: boolean;
    error?: {
        field: string;
        message: string;
        code: AssetValidationErrorCode;
    };
}

export interface AssetExistenceResult {
    exists: boolean;
    assetCode: string;
    issuer: string;
    supply?: string;
    error?: string;
}

export type AssetValidationErrorCode =
    | 'ASSET_CODE_EMPTY'
    | 'ASSET_CODE_INVALID_LENGTH'
    | 'ASSET_CODE_INVALID_CHARSET'
    | 'ASSET_ISSUER_EMPTY'
    | 'ASSET_ISSUER_INVALID';

const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Validate a Stellar asset code (1-12 alphanumeric characters).
 */
export function validateAssetCode(code: unknown): AssetValidationResult {
    if (!code || (typeof code === 'string' && code.trim() === '')) {
        return {
            valid: false,
            error: {
                field: 'stellar.asset.code',
                message: 'Asset code cannot be empty',
                code: 'ASSET_CODE_EMPTY',
            },
        };
    }

    if (typeof code !== 'string') {
        return {
            valid: false,
            error: {
                field: 'stellar.asset.code',
                message: 'Asset code must be a string',
                code: 'ASSET_CODE_INVALID_CHARSET',
            },
        };
    }

    if (code.length < 1 || code.length > 12) {
        return {
            valid: false,
            error: {
                field: 'stellar.asset.code',
                message: `Asset code must be 1-12 characters, got ${code.length}`,
                code: 'ASSET_CODE_INVALID_LENGTH',
            },
        };
    }

    if (!ASSET_CODE_RE.test(code)) {
        return {
            valid: false,
            error: {
                field: 'stellar.asset.code',
                message: 'Asset code must contain only alphanumeric characters (A-Z, a-z, 0-9)',
                code: 'ASSET_CODE_INVALID_CHARSET',
            },
        };
    }

    return { valid: true };
}

/**
 * Validate a Stellar asset issuer address format.
 */
export function validateAssetIssuer(issuer: unknown): AssetValidationResult {
    if (!issuer || (typeof issuer === 'string' && issuer.trim() === '')) {
        return {
            valid: false,
            error: {
                field: 'stellar.asset.issuer',
                message: 'Asset issuer cannot be empty',
                code: 'ASSET_ISSUER_EMPTY',
            },
        };
    }

    if (typeof issuer !== 'string' || !STELLAR_ADDRESS_RE.test(issuer)) {
        return {
            valid: false,
            error: {
                field: 'stellar.asset.issuer',
                message: 'Asset issuer must be a valid Stellar account address (56-char base32 starting with G)',
                code: 'ASSET_ISSUER_INVALID',
            },
        };
    }

    return { valid: true };
}

export interface FetchLike {
    (input: string, init?: RequestInit): Promise<Response>;
}

export class StellarAssetValidator {
    constructor(private readonly _fetch: FetchLike = fetch) {}

    validateCode(code: unknown): AssetValidationResult {
        return validateAssetCode(code);
    }

    validateIssuer(issuer: unknown): AssetValidationResult {
        return validateAssetIssuer(issuer);
    }

    /**
     * Check if an asset exists on the Stellar network via Horizon.
     */
    async checkExistence(assetCode: string, issuer: string, horizonUrl: string): Promise<AssetExistenceResult> {
        const codeResult = validateAssetCode(assetCode);
        if (!codeResult.valid) {
            return { exists: false, assetCode, issuer, error: codeResult.error?.message };
        }

        const issuerResult = validateAssetIssuer(issuer);
        if (!issuerResult.valid) {
            return { exists: false, assetCode, issuer, error: issuerResult.error?.message };
        }

        try {
            const url = `${horizonUrl.replace(/\/$/, '')}/assets?asset_code=${assetCode}&asset_issuer=${issuer}&limit=1`;
            const response = await this._fetch(url, {
                headers: { Accept: 'application/json' },
            });

            if (!response.ok) {
                return {
                    exists: false,
                    assetCode,
                    issuer,
                    error: `Horizon returned HTTP ${response.status}`,
                };
            }

            const data = await response.json() as { _embedded?: { records?: Array<{ amount: string }> } };
            const records = data._embedded?.records ?? [];

            if (records.length === 0) {
                return { exists: false, assetCode, issuer };
            }

            return {
                exists: true,
                assetCode,
                issuer,
                supply: records[0].amount,
            };
        } catch (err: unknown) {
            return {
                exists: false,
                assetCode,
                issuer,
                error: err instanceof Error ? err.message : 'Network error',
            };
        }
    }
}

export const stellarAssetValidator = new StellarAssetValidator();

// ---------------------------------------------------------------------------
// DEX Liquidity Pool Compatibility (#620)
// ---------------------------------------------------------------------------

/**
 * Stellar asset type variants for DEX compatibility checks.
 * - `alphanum4`  : 1–4 character asset codes
 * - `alphanum12` : 5–12 character asset codes
 * - `native`     : XLM (always DEX-compatible)
 */
export type AssetVariant = 'native' | 'alphanum4' | 'alphanum12';

export interface DexCompatibilityResult {
    compatible: boolean;
    variant?: AssetVariant;
    error?: {
        field: string;
        message: string;
        code: DexCompatibilityErrorCode;
    };
}

export type DexCompatibilityErrorCode =
    | AssetValidationErrorCode
    | 'DEX_INCOMPATIBLE_CODE_LENGTH'
    | 'DEX_INCOMPATIBLE_CHARSET';

/**
 * Determines the asset variant (native / alphanum4 / alphanum12) from a code.
 * Returns null if the code is invalid.
 */
export function resolveAssetVariant(code: string): AssetVariant | null {
    if (code === 'XLM') return 'native';
    if (code.length >= 1 && code.length <= 4) return 'alphanum4';
    if (code.length >= 5 && code.length <= 12) return 'alphanum12';
    return null;
}

/**
 * Validates an asset code for DEX liquidity pool compatibility.
 *
 * DEX liquidity pools on Stellar require:
 * - Alphanumeric-4 codes: 1–4 uppercase alphanumeric characters.
 * - Alphanumeric-12 codes: 5–12 uppercase alphanumeric characters.
 * - Native (XLM): always compatible.
 * - Codes with lowercase letters are rejected (Stellar asset codes are case-sensitive
 *   on-chain and lowercase codes cannot participate in DEX pools).
 *
 * @param code - The asset code to validate.
 * @returns A result indicating DEX compatibility and the resolved variant.
 */
export function validateAssetCodeDexCompatibility(code: unknown): DexCompatibilityResult {
    // Reuse existing format validation first.
    const formatResult = validateAssetCode(code);
    if (!formatResult.valid) {
        return {
            compatible: false,
            error: {
                field: formatResult.error!.field,
                message: formatResult.error!.message,
                code: formatResult.error!.code,
            },
        };
    }

    const assetCode = code as string;

    // DEX pools require uppercase-only codes.
    if (assetCode !== assetCode.toUpperCase()) {
        return {
            compatible: false,
            error: {
                field: 'stellar.asset.code',
                message: `Asset code "${assetCode}" contains lowercase characters. ` +
                    'DEX liquidity pools require uppercase alphanumeric codes only.',
                code: 'DEX_INCOMPATIBLE_CHARSET',
            },
        };
    }

    // Codes longer than 12 characters cannot be represented in either alphanum type.
    if (assetCode.length > 12) {
        return {
            compatible: false,
            error: {
                field: 'stellar.asset.code',
                message: `Asset code "${assetCode}" exceeds 12 characters and cannot participate in DEX liquidity pools.`,
                code: 'DEX_INCOMPATIBLE_CODE_LENGTH',
            },
        };
    }

    const variant = resolveAssetVariant(assetCode);

    return { compatible: true, variant: variant ?? undefined };
}
