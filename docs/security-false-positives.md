# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Host-provided auth boundary

`render-adopt.ts` and `renders-db.ts` orchestration helpers have no embedded authn/authz because **hosts** enforce it: vivijure-cf uses Cloudflare Access at the edge; vivijure-local uses bearer token + CSRF gate. Core is a library; calling it without host gates is a host misconfiguration, not a core defect.

## Single-operator studio

`normalizeProjectIdInput` accepting numeric internal IDs is intentional for orchestration paths (poll/cancel/adopt) that already hold a trusted row id from D1. Public HTTP routes use `public_id` at the host layer.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 repo | HTTP route handler with no authn/authz | Host edge auth (Access / local bearer) |
| 2026-07-23 | K3 repo | Wire intake accepts raw integer project_id | Internal orchestration id; public routes use public_id at host |
| 2026-07-23 | K3 repo | vitest.config throws without vivijure-cf checkout | Dev ergonomics guard; CI always checks out sibling modules |
