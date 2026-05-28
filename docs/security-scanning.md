# Template Dependency Security Scanning

This document describes the automated security scanning process for template dependencies to detect and remediate vulnerabilities.

## Overview

CRAFT implements comprehensive security scanning for all template dependencies using `npm audit`. The scanning process:

- Scans all template dependencies for known vulnerabilities
- Generates detailed security reports
- Integrates with CI/CD pipeline for automated checks
- Provides remediation guidance for identified vulnerabilities

## Running Security Scans

### Manual Scanning

Run the security scan script:

```bash
./scripts/security-scan.sh
```

### With Options

```bash
# Attempt to fix vulnerabilities automatically
./scripts/security-scan.sh --fix

# Output results in JSON format
./scripts/security-scan.sh --json

# Strict mode: fail on any vulnerability
./scripts/security-scan.sh --strict

# Combine options
./scripts/security-scan.sh --fix --json --strict
```

### Options

| Option | Description |
|--------|-------------|
| `--fix` | Automatically fix vulnerabilities where possible |
| `--json` | Output results in JSON format for programmatic use |
| `--strict` | Exit with error on any vulnerability (default: only critical) |

## Vulnerability Severity Levels

Vulnerabilities are classified by severity:

| Level | Description | Action |
|-------|-------------|--------|
| **Critical** | Immediate security risk | Must fix before deployment |
| **High** | Significant security risk | Should fix before deployment |
| **Medium** | Moderate security risk | Fix in next release cycle |
| **Low** | Minor security risk | Monitor and fix when convenient |

## CI/CD Integration

### GitHub Actions

Add to `.github/workflows/security.yml`:

```yaml
name: Security Scan

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run security scan
        run: ./scripts/security-scan.sh --json --strict
      
      - name: Upload security report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: security-reports
          path: security-reports/
```

### Vercel Integration

Add to `vercel.json`:

```json
{
  "buildCommand": "npm run build && ./scripts/security-scan.sh --strict",
  "env": {
    "SECURITY_SCAN_ENABLED": "true"
  }
}
```

## Security Reports

### Report Location

Reports are generated in the `security-reports/` directory:

```
security-reports/
├── security-scan-20240425_120000.json
├── security-summary-20240425_120000.txt
└── ...
```

### JSON Report Format

```json
{
  "timestamp": "2024-04-25T12:00:00Z",
  "templates": [
    {
      "name": "stellar-dex",
      "vulnerabilities": {
        "critical": 0,
        "high": 1,
        "medium": 2,
        "low": 0,
        "total": 3
      }
    }
  ],
  "summary": {
    "scanned": 4,
    "total_vulnerabilities": 5,
    "critical": 0,
    "high": 1,
    "medium": 3,
    "low": 1
  }
}
```

### Summary Report Format

```
=== Security Scan Summary ===
Templates Scanned: 4
Total Vulnerabilities: 5
  Critical: 0
  High: 1
  Medium: 3
  Low: 1

Report saved to: security-reports/security-scan-20240425_120000.json
✓ Security scan passed
```

## Remediation Procedures

### Automatic Fixes

For many vulnerabilities, npm can automatically apply fixes:

```bash
./scripts/security-scan.sh --fix
```

This command:
1. Scans all templates
2. Attempts to fix vulnerabilities automatically
3. Updates `package-lock.json`
4. Reports results

### Manual Remediation

For vulnerabilities that cannot be automatically fixed:

1. **Identify the vulnerable package:**
   ```bash
   cd templates/stellar-dex
   npm audit
   ```

2. **Review the vulnerability:**
   - Check the advisory details
   - Understand the impact
   - Verify if it affects your use case

3. **Update the package:**
   ```bash
   npm update vulnerable-package
   ```

4. **Test thoroughly:**
   ```bash
   npm test
   npm run build
   ```

5. **Verify the fix:**
   ```bash
   npm audit
   ```

### Handling Unfixable Vulnerabilities

Some vulnerabilities cannot be fixed immediately:

1. **Document the issue:**
   ```bash
   # Add to template's README.md
   ## Known Vulnerabilities
   - Package X v1.0.0: CVE-XXXX (Low severity, no fix available)
   ```

2. **Track in issue tracker:**
   - Create GitHub issue
   - Link to CVE advisory
   - Set target fix date

3. **Monitor for updates:**
   - Subscribe to package updates
   - Check for new versions regularly
   - Update when fix is available

## Best Practices

### Regular Scanning

1. **Scan on every commit:**
   - Enable CI/CD security checks
   - Fail builds on critical vulnerabilities
   - Review high-severity issues

2. **Weekly scans:**
   ```bash
   # Add to cron job
   0 0 * * 0 cd /path/to/craft && ./scripts/security-scan.sh --json
   ```

3. **Monthly reviews:**
   - Review all vulnerabilities
   - Plan remediation
   - Update dependencies

### Dependency Management

1. **Keep dependencies updated:**
   ```bash
   npm outdated
   npm update
   ```

2. **Use exact versions:**
   ```json
   {
     "dependencies": {
       "package": "1.2.3"
     }
   }
   ```

3. **Audit before adding:**
   ```bash
   npm audit --package-lock-only
   npm install new-package
   npm audit
   ```

### Security Policy

1. **Define severity thresholds:**
   - Critical: Block deployment
   - High: Require approval
   - Medium: Fix in next release
   - Low: Monitor

2. **Set remediation timelines:**
   - Critical: 24 hours
   - High: 1 week
   - Medium: 1 month
   - Low: 3 months

3. **Document exceptions:**
   - Reason for keeping vulnerable package
   - Mitigation strategies
   - Review date

## Troubleshooting

### Issue: "npm audit not found"

**Solution:**
```bash
npm install -g npm@latest
npm audit --version
```

### Issue: "Permission denied" on script

**Solution:**
```bash
chmod +x scripts/security-scan.sh
./scripts/security-scan.sh
```

### Issue: "No vulnerabilities found" but CI fails

**Solution:**
- Check for npm cache issues:
  ```bash
  npm cache clean --force
  npm audit
  ```
- Verify npm version:
  ```bash
  npm --version  # Should be 6.0.0+
  ```

### Issue: Vulnerability appears after fix

**Solution:**
- Clear npm cache:
  ```bash
  npm cache clean --force
  ```
- Reinstall dependencies:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```
- Run audit again:
  ```bash
  npm audit
  ```

## Related Documentation

- [Security Best Practices](./security.md)
- [Dependency Management](./dependencies.md)
- [CI/CD Pipeline](./deployment-guide.md)
- [npm audit Documentation](https://docs.npmjs.com/cli/v8/commands/npm-audit)

---

## HTTP Security Headers

Security headers are applied to all `/api/*` responses via `next.config.js`. The policy is based on the [OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/).

### Applied Headers

| Header | Value | Purpose |
|---|---|---|
| `Content-Security-Policy` | see below | Prevents XSS and data injection |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Enforces HTTPS |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disables unused browser APIs |

### Content Security Policy Directives

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self';
connect-src 'self' https://*.supabase.co https://api.stripe.com
            https://api.vercel.com https://horizon-testnet.stellar.org
            https://horizon.stellar.org;
frame-src 'none';
object-src 'none';
base-uri 'self';
form-action 'self';
upgrade-insecure-requests
```

### Development vs Production

In `NODE_ENV=development` the policy is sent as `Content-Security-Policy-Report-Only` so violations appear in the browser console without blocking requests. In production it is enforced via `Content-Security-Policy`.

To adjust directives, edit `next.config.js` (`CSP_DIRECTIVES` object). The canonical utility that produces the same set of headers programmatically lives in `src/lib/api/security-headers.ts`.
