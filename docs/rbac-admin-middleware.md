# Role-Based Access Control (RBAC) — Admin Routes

## Model

| Role | Access |
|---|---|
| `admin` | Admin analytics, DLQ inspection/reprocessing |
| (all authenticated users) | Own deployment analytics, profile data |
| (unauthenticated) | Public routes only |

## HTTP Status Codes

| Scenario | Status |
|---|---|
| No session / invalid token | `401 Unauthorized` |
| Authenticated but wrong role | `403 Forbidden` |
| Correct role | `200` / route-specific |

## Role Resolution

Roles are resolved **server-side** from two sources in priority order:

1. **Supabase `user_metadata.role`** — set via the Supabase admin API or a server-side migration. Never trusted from client-supplied input.
2. **`ADMIN_USER_IDS` environment variable** — comma-separated list of Supabase user UUIDs that should be treated as admins. Useful during bootstrapping before metadata is provisioned.

**Client-supplied roles are never trusted.**

## Applying `withRole` to a Route

```ts
import { withRole } from '@/lib/api/with-role';

export const GET = withRole('admin', async (req, { userId, log }) => {
  // Only reachable by admin users
  return NextResponse.json({ data: await fetchAdminData() });
});
```

## Provisioning an Admin

### Via Supabase admin API
```bash
curl -X PATCH https://<project>.supabase.co/auth/v1/admin/users/<user-id> \
  -H "apikey: <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{"user_metadata": {"role": "admin"}}'
```

### Via environment variable (development/bootstrap)
```env
ADMIN_USER_IDS=uuid-1,uuid-2
```

## Protected Routes

| Route | Method | Required Role |
|---|---|---|
| `/api/admin/analytics` | `GET` | `admin` |
| `/api/admin/webhooks/dlq` | `GET` | `admin` |
| `/api/admin/webhooks/dlq` | `POST` | `admin` |
