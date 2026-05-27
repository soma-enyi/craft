# RLS Audit — CRAFT Platform

> Issue #235 · Audited 2026-03-29 · Extended Issue #585 · 2026-05-27

## Test Coverage Matrix

Integration tests verify RLS enforcement across every protected table. Coverage includes:

| Table | SELECT | INSERT | UPDATE | DELETE | Anon Denied | Service-Role Bypass | Cross-Tenant | Edge Cases | Performance |
|-------|--------|--------|--------|--------|-------------|---------------------|--------------|------------|-------------|
| `profiles` | ✅ | ✅ | ✅ | N/A | ✅ | ✅ | ✅ | ✅ | ✅ |
| `deployments` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `deployment_logs` | ✅ | ✅ | N/A | N/A | ✅ | ✅ | ✅ | ✅ | ✅ |
| `deployment_analytics` | ✅ | ✅ | N/A | N/A | ✅ | ✅ | ✅ | ✅ | ✅ |
| `customization_drafts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `templates` | ✅ | N/A | N/A | N/A | N/A (public read) | ✅ | N/A | ✅ | ✅ |
| `github_vercel_deployments` | ✅ | N/A | N/A | N/A | ✅ | ✅ | N/A (all authed users can read) | ✅ | N/A |
| `deployment_updates` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A |

**Test file**: `supabase/tests/rls/policy-verification.test.ts`

**Test categories**:
1. **Service-role bypass** — Verifies service_role skips all policies (all 8 tables)
2. **Cross-table isolation** — Ensures users cannot access other users' data via indirect joins
3. **Edge cases** — NULL uid, empty deployment sets, profile id mismatches
4. **Policy conflicts** — UPDATE USING vs WITH CHECK predicates
5. **Performance** — Indirect-join policies scale linearly with owned deployments, not total table size
6. **github_vercel_deployments** — Authenticated SELECT (all rows), service_role ALL, anon denial
7. **deployment_updates** — Per-user ALL policy: SELECT/INSERT/UPDATE/DELETE isolation
8. **Anonymous denial** — Comprehensive anon denial test covering all 15 protected policy+table combinations

**Key assertions**:
- User A cannot read User B's deployments, logs, analytics, or drafts
- User A cannot update User B's profiles, drafts, or deployment_updates
- Service role bypasses all policies unconditionally on all tables
- Anon role is denied all access to user-scoped tables (15 cases verified)
- Indirect-join policies correctly filter by owned deployment set
- `github_vercel_deployments` is readable by all authenticated users but not anon
- `deployment_updates` enforces per-user isolation on all CRUD operations

## Summary Table

| Table                  | RLS Enabled | Policies (ops)                                      | Findings                                                                                  |
|------------------------|-------------|-----------------------------------------------------|-------------------------------------------------------------------------------------------|
| `profiles`             | ✅           | SELECT, UPDATE, INSERT (own row only)               | No DELETE policy — intentional (cascade from auth.users). ✅                              |
| `deployments`          | ✅           | SELECT, INSERT, UPDATE, DELETE (own rows only)      | Full CRUD covered. ✅                                                                      |
| `deployment_logs`      | ✅           | SELECT (own deployments), INSERT `WITH CHECK (true)`| ⚠️ **FINDING F-1**: INSERT allows any authed user to write logs for any deployment_id.    |
| `customization_drafts` | ✅           | SELECT, INSERT, UPDATE, DELETE (own rows only)      | Full CRUD covered. ✅                                                                      |
| `deployment_analytics` | ✅           | SELECT (own deployments), INSERT `WITH CHECK (true)`| ⚠️ **FINDING F-2**: INSERT allows any authed user to write metrics for any deployment_id. |
| `templates`            | ✅           | SELECT (active only), ALL (service_role only)       | Intentionally public read. Service-role write is correct. ✅                               |
| `github_vercel_deployments` | ✅      | SELECT (all authenticated), ALL (service_role)      | Intentionally public within authed session — no per-user filter on SELECT. ✅              |
| `deployment_updates`   | ✅           | ALL (own rows via `user_id`)                        | Full CRUD protected. Per-user isolation enforced. ✅                                       |

---

## Findings

### F-1 — `deployment_logs`: overly-permissive INSERT

**Policy**: `"System can insert deployment logs"` — `WITH CHECK (true)`

**Risk**: Any authenticated user can insert a log row with an arbitrary `deployment_id`, including one belonging to another user. This could pollute another user's log stream or be used to inject misleading log entries.

**Mitigation in practice**: All log writes in the application go through the service_role key, which bypasses RLS entirely. The policy is therefore never exercised by normal application code.

**Recommendation**: Either drop the policy entirely (rely on service_role bypass) or tighten it:

```sql
-- Option A: drop — service_role writes bypass RLS anyway
DROP POLICY "System can insert deployment logs" ON deployment_logs;

-- Option B: restrict to own deployments (if user-side inserts are ever needed)
CREATE POLICY "Users can insert logs for own deployments" ON deployment_logs
    FOR INSERT WITH CHECK (
        deployment_id IN (SELECT id FROM deployments WHERE user_id = auth.uid())
    );
```

---

### F-2 — `deployment_analytics`: overly-permissive INSERT

**Policy**: `"System can insert analytics"` — `WITH CHECK (true)`

Same risk and recommendation as F-1. All analytics writes are server-side via service_role.

---

## Policy Details

### `profiles`

| Policy name                  | Op     | Expression                  |
|------------------------------|--------|-----------------------------|
| Users can view own profile   | SELECT | `auth.uid() = id`           |
| Users can update own profile | UPDATE | `auth.uid() = id`           |
| Users can insert own profile | INSERT | `auth.uid() = id`           |

User identity: `auth.uid()` compared to the row's primary key (`id`, which mirrors `auth.users.id`).

---

### `deployments`

| Policy name                    | Op     | Expression                  |
|--------------------------------|--------|-----------------------------|
| Users can view own deployments | SELECT | `auth.uid() = user_id`      |
| Users can create own deployments | INSERT | `auth.uid() = user_id`    |
| Users can update own deployments | UPDATE | `auth.uid() = user_id`    |
| Users can delete own deployments | DELETE | `auth.uid() = user_id`    |

---

### `deployment_logs`

| Policy name                              | Op     | Expression                                                                 |
|------------------------------------------|--------|----------------------------------------------------------------------------|
| Users can view logs for own deployments  | SELECT | `deployment_id IN (SELECT id FROM deployments WHERE user_id = auth.uid())` |
| System can insert deployment logs ⚠️     | INSERT | `true`                                                                     |

---

### `customization_drafts`

| Policy name                  | Op     | Expression                  |
|------------------------------|--------|-----------------------------|
| Users can view own drafts    | SELECT | `auth.uid() = user_id`      |
| Users can create own drafts  | INSERT | `auth.uid() = user_id`      |
| Users can update own drafts  | UPDATE | `auth.uid() = user_id`      |
| Users can delete own drafts  | DELETE | `auth.uid() = user_id`      |

---

### `deployment_analytics`

| Policy name                                    | Op     | Expression                                                                 |
|------------------------------------------------|--------|----------------------------------------------------------------------------|
| Users can view analytics for own deployments   | SELECT | `deployment_id IN (SELECT id FROM deployments WHERE user_id = auth.uid())` |
| System can insert analytics ⚠️                 | INSERT | `true`                                                                     |

---

### `templates`

| Policy name                      | Op  | Expression                                  |
|----------------------------------|-----|---------------------------------------------|
| Anyone can view active templates | SELECT | `is_active = true`                     |
| Service role can manage templates | ALL | `auth.jwt()->>'role' = 'service_role'`  |

Intentionally public: templates are platform-managed catalogue data, not user-specific.

---

### `github_vercel_deployments`

| Policy name                                       | Op     | Expression                                            |
|---------------------------------------------------|--------|-------------------------------------------------------|
| Service role can manage github_vercel_deployments | ALL    | `true` (role: service_role)                           |
| Authenticated users can read github_vercel_deployments | SELECT | `true` (role: authenticated)                  |

Intentionally readable by all authenticated users — no per-user filter. All writes go through the service_role path (webhook handler). Anon access is denied.

---

### `deployment_updates`

| Policy name                                    | Op  | Expression                                                       |
|------------------------------------------------|-----|------------------------------------------------------------------|
| Users can manage their own deployment updates  | ALL | USING `auth.uid() = user_id` / WITH CHECK `auth.uid() = user_id` |

Full per-user CRUD isolation. Authenticated users can only read, create, update, or delete their own rows. Ownership transfer via UPDATE is blocked by WITH CHECK.
