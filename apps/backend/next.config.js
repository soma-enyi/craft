/** @type {import('next').NextConfig} */

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

function buildCsp() {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, values]) =>
      values.length ? `${directive} ${values.join(' ')}` : directive
    )
    .join('; ');
}

const cspHeaderName = isDev
  ? 'Content-Security-Policy-Report-Only'
  : 'Content-Security-Policy';

const securityHeaders = [
  { key: cspHeaderName, value: buildCsp() },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@craft/types', '@craft/stellar', '@craft/ui'],
  async headers() {
    return [
      {
        // Apply to all API routes. The runtime corsHeaders() utility enforces
        // the per-origin allow-list; these static headers cover the common
        // non-credentialed fields that are safe to set globally.
        // Webhook routes (/api/webhooks/*) are intentionally included here
        // only for the method/header declarations — origin gating is handled
        // by the runtime utility and Stripe signature verification.
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-Requested-With' },
          { key: 'Access-Control-Max-Age', value: '86400' },
          ...securityHeaders,
        ],
      },
    ];
  },
};

module.exports = nextConfig;
