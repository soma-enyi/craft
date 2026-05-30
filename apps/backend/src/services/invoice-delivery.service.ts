/**
 * InvoiceDeliveryService
 *
 * Retrieves the hosted invoice PDF from Stripe and emails it to the customer
 * upon subscription renewal (invoice.paid webhook).
 *
 * Delivery flow:
 *   1. Retrieve the invoice from Stripe to get the hosted_invoice_url and
 *      invoice_pdf URL (Stripe-hosted; no binary download required).
 *   2. Resolve the customer email from the invoice or Stripe customer record.
 *   3. Send the email with a link to the PDF using the configured email provider.
 *   4. Retry transient failures with exponential back-off.
 *
 * Email provider:
 *   Uses fetch against the EMAIL_API_URL endpoint (e.g. Resend, SendGrid).
 *   Set EMAIL_API_KEY and EMAIL_FROM in environment variables.
 *   Falls back to console logging when EMAIL_API_URL is not configured (dev mode).
 *
 * Environment variables:
 *   EMAIL_API_URL   — Base URL of the email API (e.g. https://api.resend.com)
 *   EMAIL_API_KEY   — API key for the email provider
 *   EMAIL_FROM      — Sender address (e.g. billing@craft.app)
 */

import { stripe } from '@/lib/stripe/client';
import { retryWithBackoff } from '@/lib/retry/exponential-backoff';

export interface InvoiceDeliveryResult {
    invoiceId: string;
    customerEmail: string;
    pdfUrl: string;
    delivered: boolean;
}

export class InvoiceDeliveryService {
    /**
     * Deliver the invoice PDF for the given Stripe invoice ID.
     * Retries transient email failures with exponential back-off.
     */
    async deliverInvoicePdf(invoiceId: string): Promise<InvoiceDeliveryResult> {
        // Retrieve invoice from Stripe (includes hosted_invoice_url + invoice_pdf)
        const invoice = await stripe.invoices.retrieve(invoiceId, {
            expand: ['customer'],
        });

        const pdfUrl = invoice.invoice_pdf;
        if (!pdfUrl) {
            throw new Error(`Invoice ${invoiceId} has no PDF URL`);
        }

        // Resolve customer email
        const customerEmail = this.resolveEmail(invoice);
        if (!customerEmail) {
            throw new Error(`Cannot resolve email for invoice ${invoiceId}`);
        }

        // Send email with retry
        const result = await retryWithBackoff(
            () => this.sendInvoiceEmail(customerEmail, invoice.number ?? invoiceId, pdfUrl),
            { maxAttempts: 3, initialDelayMs: 500 },
        );

        if (!result.success) {
            throw result.error;
        }

        return {
            invoiceId,
            customerEmail,
            pdfUrl,
            delivered: true,
        };
    }

    private resolveEmail(invoice: any): string | null {
        // invoice.customer_email is set directly on the invoice
        if (invoice.customer_email) return invoice.customer_email;
        // expanded customer object
        if (invoice.customer && typeof invoice.customer === 'object') {
            return (invoice.customer as any).email ?? null;
        }
        return null;
    }

    private async sendInvoiceEmail(
        to: string,
        invoiceNumber: string,
        pdfUrl: string,
    ): Promise<void> {
        const apiUrl = process.env.EMAIL_API_URL;

        if (!apiUrl) {
            // Dev / test mode — log instead of sending
            console.log(`[InvoiceDelivery] Would send invoice ${invoiceNumber} PDF to ${to}: ${pdfUrl}`);
            return;
        }

        const from = process.env.EMAIL_FROM ?? 'billing@craft.app';
        const apiKey = process.env.EMAIL_API_KEY ?? '';

        const res = await fetch(`${apiUrl}/emails`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                from,
                to,
                subject: `Your CRAFT invoice ${invoiceNumber}`,
                html: `<p>Thank you for your subscription.</p>
<p>Your invoice <strong>${invoiceNumber}</strong> is ready.</p>
<p><a href="${pdfUrl}">Download Invoice PDF</a></p>`,
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            const err: any = new Error(`Email API error ${res.status}: ${text}`);
            err.status = res.status;
            throw err;
        }
    }
}

export const invoiceDeliveryService = new InvoiceDeliveryService();
