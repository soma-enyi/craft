/**
 * Security headers applied to all API responses.
 *
 * CSP is in report-only mode in development so violations are visible in the
 * browser console without breaking the app. In production the policy is
 * enforced via Content-Security-Policy.
 *
 * References:
 *   https://owasp.org/www-project-secure-headers/
 *   https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
 */

const isDev = process.env.NODE_ENV !== 'production';

const CSP_DIRECTIVES = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'font-src': ["'self'"],
    'connect-src': [
        "'self'",
        'https://*.supabase.co',
        'https://api.stripe.com',
        'https://api.vercel.com',
        'https://horizon-testnet.stellar.org',
        'https://horizon.stellar.org',
    ],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'upgrade-insecure-requests': [],
};

function buildCsp(): string {
    return Object.entries(CSP_DIRECTIVES)
        .map(([directive, values]) =>
            values.length ? `${directive} ${values.join(' ')}` : directive
        )
        .join('; ');
}

const cspValue = buildCsp();

export interface SecurityHeader {
    key: string;
    value: string;
}

/**
 * Returns the full set of security headers.
 * In development, CSP is report-only; in production it is enforced.
 */
export function getSecurityHeaders(): SecurityHeader[] {
    const cspHeaderName = isDev
        ? 'Content-Security-Policy-Report-Only'
        : 'Content-Security-Policy';

    return [
        { key: cspHeaderName, value: cspValue },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];
}
