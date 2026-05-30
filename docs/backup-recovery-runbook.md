# Supabase Database Backup & Point-in-Time Recovery Runbook

## Overview

CRAFT uses Supabase Pro/Enterprise for managed PostgreSQL hosting. Supabase provides:

- **Continuous WAL archiving** — changes are streamed to object storage in real time.
- **Point-in-Time Recovery (PITR)** — restore to any second within the retention window (7 days on Pro, 30 days on Enterprise).
- **Daily base snapshots** — full daily backups retained alongside PITR logs.

Recovery Time Objective (RTO): **< 30 minutes** for the current schema size.
Recovery Point Objective (RPO): **< 1 minute** (WAL archiving granularity).

---

## Backup Configuration

### Enabling PITR on Supabase

PITR is enabled per-project in the Supabase dashboard:

1. Navigate to **Project Settings → Database → Backups**.
2. Ensure **Point in Time Recovery** is toggled **on**.
3. Confirm the retention period matches your compliance requirements (7 or 30 days).

### Verifying Backup Health

Run the following check weekly to confirm WAL archiving is active:

```sql
SELECT pg_is_in_recovery(), pg_current_wal_lsn();
```

The `pg_current_wal_lsn` value must advance between subsequent calls, confirming WAL is being generated and archived.

---

## Recovery Procedures

### Restore to a Specific Point in Time

1. **Open the Supabase Dashboard** → Project → **Backups** → **Point in Time Recovery**.
2. Select the target date and time (UTC).
3. Confirm the restore target — Supabase will spin up a new instance from the nearest base snapshot and replay WAL logs up to the chosen timestamp.
4. Once the restored instance is healthy, update `SUPABASE_DB_URL` / connection strings in Vercel environment variables to point to the restored instance.
5. Verify connectivity with a smoke-test query:
   ```sql
   SELECT COUNT(*) FROM profiles;
   ```

> **Important:** Supabase PITR restores create a *new* database instance — the original is not modified. This allows side-by-side comparison before switching traffic.

### Restore from Daily Backup

If PITR is unavailable, fall back to the most recent daily snapshot:

1. Dashboard → **Backups** → select the latest **Daily Backup** entry.
2. Click **Restore** and follow the prompts.
3. Expected restore time: < 30 minutes for the CRAFT schema.

---

## Post-Restore Verification Checklist

After any restore, run through the following checks before re-routing production traffic:

- [ ] All expected tables present (`profiles`, `deployments`, `deployment_logs`, `customization_drafts`, `deployment_analytics`, `templates`).
- [ ] Row-Level Security is enabled on all user-data tables.
- [ ] Encrypted columns (`github_token_encrypted`, `stripe_customer_id_encrypted`, `stripe_subscription_id_encrypted`) contain no plaintext values.
- [ ] Foreign key constraints intact — `ON DELETE CASCADE` from `profiles → deployments → deployment_logs`.
- [ ] Migration sequence is gap-free (run the migration ordering test in `supabase/tests/backup/recovery.test.ts`).
- [ ] Application smoke test: create a profile, create a deployment, verify it appears in `deployment_logs`.

---

## Backup Integrity Verification

The automated test suite at `supabase/tests/backup/recovery.test.ts` verifies the schema properties that must hold before a backup is taken and after a restore is applied.

Run tests with:

```bash
pnpm test supabase/tests/backup/recovery.test.ts
```

Tests cover:

| Suite | What is verified |
|---|---|
| Backup completeness | All tables, indexes, and triggers present in migrations |
| Migration ordering | Migrations apply sequentially without gaps |
| Data integrity | CHECK constraints and FK cascade rules |
| PITR idempotency | Migrations use `IF NOT EXISTS` guards — safe to replay |
| RLS coverage | Every user-data table has RLS + scoped SELECT policy |
| Disaster recovery | Sensitive columns have plaintext-prevention constraints |
| Restore simulation | In-process replay of migration subsets up to any point |

---

## Sensitive Data After Restore

The following columns must **never** contain plaintext values post-restore:

| Column | Table | Constraint |
|---|---|---|
| `github_token_encrypted` | `profiles` | `profiles_github_token_not_plaintext` |
| `stripe_customer_id_encrypted` | `profiles` | `profiles_stripe_customer_not_plaintext` |
| `stripe_subscription_id_encrypted` | `profiles` | `profiles_stripe_subscription_not_plaintext` |

If plaintext values are detected, rotate the affected credentials immediately and notify the security team.

---

## Escalation

| Scenario | Action |
|---|---|
| Restore takes > 45 minutes | Contact Supabase support with project ref and target timestamp |
| RLS policies missing post-restore | Re-apply `supabase/migrations/002_rls_policies.sql` manually |
| WAL archiving not advancing | Open Supabase support ticket — do not attempt manual WAL management |
| PITR window exceeded | Restore from nearest daily backup and document data loss window |
