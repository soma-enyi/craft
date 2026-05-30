/**
 * Stripe Tax configuration helpers for regional subscription pricing compliance.
 *
 * Stripe Tax automatically calculates and applies the correct tax rates based
 * on the customer's billing address. This module configures automatic tax
 * collection and handles tax-exempt customers.
 *
 * Requirements
 * ────────────
 * - STRIPE_TAX_ENABLED env var must be "true" to activate tax collection.
 * - Tax-exempt status is stored per-customer on the Stripe Customer object
 *   (tax_exempt: "none" | "exempt" | "reverse").
 * - Tax-inclusive pricing is enabled in regions where required (e.g. EU VAT).
 *
 * Supported exemption types
 * ─────────────────────────
 * none     : Regular taxable customer (default).
 * exempt   : Tax-exempt organisations (e.g. non-profits, governments).
 * reverse  : B2B customers in eligible regions (VAT reverse charge).
 *
 * Feature: stripe-tax-rate-configuration
 * Issue: #655
 */

export type TaxExemptStatus = 'none' | 'exempt' | 'reverse';

export interface TaxConfiguration {
    /** Whether Stripe Tax automatic calculation is enabled. */
    enabled: boolean;
    /** Whether to collect the customer's tax ID at checkout. */
    collectTaxId: boolean;
}

/** Returns the current Stripe Tax configuration from environment variables. */
export function getTaxConfiguration(): TaxConfiguration {
    return {
        enabled: process.env.STRIPE_TAX_ENABLED === 'true',
        collectTaxId: process.env.STRIPE_TAX_COLLECT_ID === 'true',
    };
}

/**
 * Returns Stripe checkout session params for automatic tax calculation.
 * Call this and spread the result into the checkout session `create` call.
 */
export function buildCheckoutTaxParams(config: TaxConfiguration): {
    automatic_tax?: { enabled: boolean };
    tax_id_collection?: { enabled: boolean };
} {
    if (!config.enabled) return {};

    return {
        automatic_tax: { enabled: true },
        ...(config.collectTaxId ? { tax_id_collection: { enabled: true } } : {}),
    };
}

/**
 * Returns the Stripe Customer update payload to apply a tax exemption status.
 * Pass the result to `stripe.customers.update(customerId, payload)`.
 */
export function buildTaxExemptUpdate(status: TaxExemptStatus): { tax_exempt: TaxExemptStatus } {
    return { tax_exempt: status };
}

/**
 * Returns whether a customer's exemption status means they should not be
 * charged tax.
 */
export function isTaxExempt(status: TaxExemptStatus): boolean {
    return status === 'exempt' || status === 'reverse';
}
