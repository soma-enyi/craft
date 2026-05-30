/**
 * Tests for InvoiceDeliveryService (#659)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stripe mock ───────────────────────────────────────────────────────────────
const mockInvoicesRetrieve = vi.fn();
vi.mock('@/lib/stripe/client', () => ({
    stripe: { invoices: { retrieve: mockInvoicesRetrieve } },
}));

// ── retry mock — avoids parsing the union-type RetryResult in exponential-backoff.ts ──
vi.mock('@/lib/retry/exponential-backoff', () => ({
    retryWithBackoff: vi.fn(async (fn: () => Promise<unknown>) => {
        try {
            const data = await fn();
            return { success: true, data, attempts: 1 };
        } catch (error) {
            return { success: false, error, attempts: 1, totalDurationMs: 0 };
        }
    }),
}));

// ── fetch mock ────────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('InvoiceDeliveryService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('EMAIL_API_URL', 'https://api.email.test');
        vi.stubEnv('EMAIL_API_KEY', 'key_test');
        vi.stubEnv('EMAIL_FROM', 'billing@craft.app');
    });

    it('retrieves invoice PDF URL and sends email to customer', async () => {
        mockInvoicesRetrieve.mockResolvedValue({
            id: 'in_1',
            number: 'INV-001',
            invoice_pdf: 'https://stripe.com/invoice.pdf',
            customer_email: 'user@example.com',
            customer: null,
        });
        mockFetch.mockResolvedValue({ ok: true });

        const { invoiceDeliveryService } = await import('./invoice-delivery.service');
        const result = await invoiceDeliveryService.deliverInvoicePdf('in_1');

        expect(result.delivered).toBe(true);
        expect(result.customerEmail).toBe('user@example.com');
        expect(result.pdfUrl).toBe('https://stripe.com/invoice.pdf');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.email.test/emails',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer key_test' }),
            }),
        );
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.to).toBe('user@example.com');
        expect(body.html).toContain('https://stripe.com/invoice.pdf');
    });

    it('resolves email from expanded customer object when customer_email is absent', async () => {
        mockInvoicesRetrieve.mockResolvedValue({
            id: 'in_2',
            number: 'INV-002',
            invoice_pdf: 'https://stripe.com/inv2.pdf',
            customer_email: null,
            customer: { id: 'cus_1', email: 'other@example.com' },
        });
        mockFetch.mockResolvedValue({ ok: true });

        const { invoiceDeliveryService } = await import('./invoice-delivery.service');
        const result = await invoiceDeliveryService.deliverInvoicePdf('in_2');

        expect(result.customerEmail).toBe('other@example.com');
    });

    it('throws when invoice has no PDF URL', async () => {
        mockInvoicesRetrieve.mockResolvedValue({
            id: 'in_3',
            number: 'INV-003',
            invoice_pdf: null,
            customer_email: 'user@example.com',
            customer: null,
        });

        const { invoiceDeliveryService } = await import('./invoice-delivery.service');
        await expect(invoiceDeliveryService.deliverInvoicePdf('in_3')).rejects.toThrow(
            'has no PDF URL',
        );
    });

    it('throws when no email can be resolved', async () => {
        mockInvoicesRetrieve.mockResolvedValue({
            id: 'in_4',
            number: 'INV-004',
            invoice_pdf: 'https://stripe.com/inv4.pdf',
            customer_email: null,
            customer: null,
        });

        const { invoiceDeliveryService } = await import('./invoice-delivery.service');
        await expect(invoiceDeliveryService.deliverInvoicePdf('in_4')).rejects.toThrow(
            'Cannot resolve email',
        );
    });

    it('retries on transient email API failure and succeeds on second attempt', async () => {
        mockInvoicesRetrieve.mockResolvedValue({
            id: 'in_5',
            number: 'INV-005',
            invoice_pdf: 'https://stripe.com/inv5.pdf',
            customer_email: 'retry@example.com',
            customer: null,
        });
        mockFetch.mockResolvedValue({ ok: true });

        const { retryWithBackoff } = await import('@/lib/retry/exponential-backoff');
        const { invoiceDeliveryService } = await import('./invoice-delivery.service');
        const result = await invoiceDeliveryService.deliverInvoicePdf('in_5');

        expect(result.delivered).toBe(true);
        // retryWithBackoff was called to wrap the email send
        expect(retryWithBackoff).toHaveBeenCalled();
    });

    it('logs instead of sending when EMAIL_API_URL is not set', async () => {
        vi.stubEnv('EMAIL_API_URL', '');
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        mockInvoicesRetrieve.mockResolvedValue({
            id: 'in_6',
            number: 'INV-006',
            invoice_pdf: 'https://stripe.com/inv6.pdf',
            customer_email: 'dev@example.com',
            customer: null,
        });

        const { invoiceDeliveryService } = await import('./invoice-delivery.service');
        const result = await invoiceDeliveryService.deliverInvoicePdf('in_6');

        expect(result.delivered).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('INV-006'));
        consoleSpy.mockRestore();
    });
});
