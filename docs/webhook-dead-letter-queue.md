# Webhook Dead Letter Queue (DLQ)

## Overview

When a webhook event (Stripe or GitHub) fails to process after `MAX_ATTEMPTS` (3) retries, the full original payload and failure reason are captured in the Dead Letter Queue instead of being silently dropped.

## DLQ Workflow

```
Webhook received
       │
  verify signature
       │
  attempt processing ──► success ──► 200 OK
       │ (up to 3x)
       ▼ all attempts failed
  capture to DLQ ──► 200 OK (so provider stops retrying)
       │
  Admin inspects via GET /api/admin/webhooks/dlq
       │
  Admin triggers reprocess via POST /api/admin/webhooks/dlq
       │
  processor re-runs ──► success: entry marked succeeded
                    └──► failure: entry marked failed, reason updated
```

## DLQ Entry Schema

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique DLQ entry ID (`dlq_<timestamp>_<random>`) |
| `source` | `stripe` \| `github` | Webhook origin |
| `eventType` | string | Event type (e.g. `invoice.payment_failed`, `push`) |
| `payload` | string | Full original raw JSON payload |
| `failureReason` | string | Error message from the last failed attempt |
| `attempts` | number | Number of processing attempts made before capture |
| `createdAt` | ISO 8601 | When the entry was captured |
| `reprocessedAt` | ISO 8601 \| undefined | When reprocessing was last attempted |
| `reprocessStatus` | `pending` \| `succeeded` \| `failed` | Outcome of latest reprocess attempt |

## Admin Endpoints

Both endpoints require the `admin` role (see [RBAC docs](./rbac-admin-middleware.md)).

### `GET /api/admin/webhooks/dlq`

Returns all DLQ entries sorted newest-first.

```json
{
  "total": 1,
  "entries": [
    {
      "id": "dlq_1716900000000_abc1234",
      "source": "stripe",
      "eventType": "invoice.payment_failed",
      "payload": "{...}",
      "failureReason": "Payment service unavailable",
      "attempts": 3,
      "createdAt": "2024-05-28T12:00:00.000Z",
      "reprocessStatus": "pending"
    }
  ]
}
```

### `POST /api/admin/webhooks/dlq`

Reprocess a single DLQ entry.

**Request body:**
```json
{ "id": "dlq_1716900000000_abc1234" }
```

**Response (success):**
```json
{ "success": true, "entry": { ...updated entry... } }
```

**Response (failure):**
```json
{ "error": "Payment service unavailable", "entry": { ...entry with failed status... } }
```

## Preventing Infinite Loops

- Each entry can only be marked `succeeded` once; reprocessing a succeeded entry returns a 422.
- There is no automatic re-enqueueing; reprocessing is always manually triggered by an admin.

## Production Recommendations

The current backing store is in-process memory, suitable for single-instance deployments. For multi-instance or durable storage requirements:

1. Replace the `Map` in `src/lib/webhook-dlq/dead-letter-queue.ts` with a Supabase table or Redis sorted set.
2. Add a database migration to create a `webhook_dlq` table with columns matching `DLQEntry`.
