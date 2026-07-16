---
inclusion: always
---

# Product Overview

Restore and Transfer Orchestrator — an internal tool that orchestrates S3 Glacier restores and AWS DataSync transfers to on-premises NFS destinations.

Users submit restore requests (specifying an S3 bucket, file paths or glob patterns, retrieval tier, and optionally a DataSync destination) through a REST API or web UI. The system resolves paths, detects storage classes, initiates Glacier restores (individually or via S3 Batch Operations for large sets), monitors completion, then triggers a manifest-based DataSync transfer of the restored objects.

## Domain Concepts

| Term | Meaning |
|------|---------|
| Restore Request | A user-submitted job specifying bucket, file paths, retrieval tier, and restore duration |
| Retrieval Tier | Speed/cost tradeoff for Glacier restores: `Expedited`, `Standard`, `Bulk` |
| Storage Class | S3 tier: `GLACIER`, `DEEP_ARCHIVE`, `GLACIER_IR` (Instant Retrieval needs no restore) |
| Batch Threshold | ≥50 objects triggers S3 Batch Operations instead of individual RestoreObject calls |
| Durable Execution | Lambda workflow that suspends during long waits (hours/days) without incurring compute cost |
| Manifest | CSV file listing object keys, used by both S3 Batch Operations and DataSync to scope operations |

## Workflow Lifecycle

1. **Submitted** — Request persisted to DynamoDB with ULID key
2. **Resolving Paths** — Glob patterns expanded to concrete S3 keys
3. **Detecting Storage Class** — HeadObject on each key to determine tier and restore status
4. **Initiating Restore** — RestoreObject calls (individual) or S3 Batch job (≥50 objects)
5. **Restore In Progress** — Exponential-backoff polling (5 min → 30 min cap) until objects are restored
6. **Restore Complete** — All objects accessible in S3 Standard
7. **Starting DataSync** — Manifest uploaded, DataSync task execution created
8. **DataSync In Progress** — Fixed 60-second polling until terminal state
9. **Transfer Complete** / error terminal states

Terminal (no further transitions): `Transfer Complete`, `Restore Timed Out`, `DataSync Failed`, `Transfer Timed Out`, `Transfer Status Unknown`, `Error`

## Key Behaviors and Constraints

- Objects already restored or in `GLACIER_IR` are skipped (no redundant restore)
- Objects with a restore already in-progress are monitored, not re-initiated
- Timeout per tier: Expedited 12h, Standard 48h, Bulk 72h; DataSync timeout: 60 min
- Requests are limited to 1–1000 file paths; bucket names 3–63 chars; restore days 1–30
- DynamoDB records have a 30-day TTL after completion
- 3 consecutive DataSync polling failures → status marked `Transfer Status Unknown`
- Batch job manifest and DataSync transfer manifest are stored in a shared staging bucket

## Environments

Two deployment targets controlled by the `ENV` environment variable:

| Env | Purpose |
|-----|---------|
| `dev` | Development and testing (default when `ENV` is unset) |
| `prod` | Production workloads |

Environment-specific values (DataSync task ARN, staging bucket, Batch role ARN, DataSync S3 role ARN) are resolved at CDK synth time from environment variables with fallback placeholders in `lib/config/environment.ts`.

## API Surface

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/requests` | POST | Submit a new restore request |
| `/requests` | GET | List recent requests (max 50) |
| `/requests/{id}` | GET | Get status of a specific request |
| `/requests/{id}/manifest` | GET | Get presigned URL for the transfer manifest |

All endpoints require Cognito JWT authentication via API Gateway authorizer.

## Web UI

Static vanilla JS/HTML/CSS app served via CloudFront + S3. Authenticates using Cognito hosted UI with PKCE authorization code flow. Runtime config (`config.js`) is generated at deploy time — never committed with real values.
