# Storage accounting + `R2_STORAGE_QUOTA_BYTES`

The host-neutral storage ceiling (core#52, ruled on vivijure-cf#56). One implementation in
`src/storage-quota.ts`, wired identically by both panels: `vivijure-cf` (Workers + D1 + R2) and
`vivijure-local` (Node + SQLite + MinIO/S3). Hosted sets the var per tenant; a self-hoster sets it to cap
their own object-storage bill. Same feature, same release, both doors.

## The knob

| Var | Default | Meaning |
|---|---|---|
| `R2_STORAGE_QUOTA_BYTES` | unset | Unset / `0` / non-integer = **OFF** (absent knob, absent behavior). A positive integer = the ceiling in **bytes**, enforced at submit. |

Bytes only. There is no `10GB` unit parsing on purpose: a mis-parsed unit is an order-of-magnitude error
on somebody's bill.

```
R2_STORAGE_QUOTA_BYTES=53687091200     # 50 GiB
R2_STORAGE_QUOTA_BYTES=1099511627776   # 1 TiB
```

## What happens when the ceiling is reached

The artifact-writing POST routes (uploads, GPU submits, LoRA training, audio generation) are denied
**before** the spend, with the real numbers in the error:

```
HTTP 507 Insufficient Storage
{"error":"storage quota reached: 53690000000 bytes stored of the 53687091200-byte
          R2_STORAGE_QUOTA_BYTES ceiling; delete renders or raise the knob"}
```

Never a silent truncation, never a partial render, never a quota failure discovered halfway through a
film. Reads, deletes, the planner, and chat keep working, so the operator can look at what they have and
delete something.

**Fail-closed on a broken check.** If the quota is SET but its own check cannot run (no database binding,
or the ledger query throws), submissions are denied `503` rather than allowed. Same posture as
`SPEND_DAILY_CEILING`: a novice self-funds the bill and must not silently run unmetered on a
misconfigured studio. The quota being OFF is not a broken check; it is a no-op that never touches the
database.

### What is gated, and what is deliberately not

Gated: `/api/upload`, `/api/storyboard/{audio-upload,character-ref,bundle,render,render/scatter,
render-from-keyframes,score-bed,music-generate}`, `/api/render/{clips,film}`,
`/api/storyboard/renders/:id/{regen-shot,finalize,animate-cloud,animate-hybrid,add-audio,add-narration}`,
`/api/cast/{import,:id/portrait,:id/ref,:id/source,:id/generate-refs,:id/train-lora,:id/train-wan-lora}`.

Not gated, and why:

- `/api/chat` -- its text branch stores nothing, and denying text chat because the video bucket is full
  is over-blocking. Its image branch stores a small file; the byte-heavy paths are all gated, and a full
  studio is denied at its next render submit.
- The planner routes (`plan`, `refine`, `enhance`, `preflight`, `render-plan`, `markers`, `yaml`) -- they
  spend AI money, which is `SPEND_DAILY_CEILING`'s meter, not this one. They store no artifact.

## Where the number comes from

The host database, accounted at **write time** (D1 on Workers, SQLite on the Node host). Never an R2 or
S3 bucket-usage API read: that is Cloudflare-specific, so it would break the Node/MinIO host, which is a
parity break for a parity feature; it is also eventually consistent and would need object-store creds in
the render path.

`storage_usage` is a ledger keyed on the object key:

```sql
CREATE TABLE IF NOT EXISTS storage_usage (
  object_key TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Both panel migrations carry that DDL verbatim, and each panel has a test asserting its migration file
still matches `STORAGE_USAGE_DDL` in core, so the two hosts cannot drift apart.

**The accounting rule, one rule with no exceptions:** every object write upserts its key at its current
size; every delete (user delete, orphan-GC, panel cleanup) drops its row. Keying on the object key is
what makes this honest under rewrite: a film job doc is written to the same key on every advance tick,
and each write **updates** its row rather than adding to a total. Intermediates count while they exist,
because they occupy bytes while they exist and the operator is billed for them while they exist.

The seam is a metering wrapper around the renders store (`meteredR2Bucket` on Workers,
`meteredObjectStore` on the Node host), applied once where each panel builds its environment. Wrapping is
idempotent, so a per-request seam cannot double count. Writes that bypass that wrapper are not accounted,
which is why each panel wires it at exactly one place.

**Accounting never fails a write.** The meter is a meter, not a gate: if the ledger write throws, the
object write still succeeds and the counter drifts LOW with a warning on the log. The gate is at submit.

## Reconcile (backfill and drift repair)

Artifact sizes are **not** derivable from the studio database (renders rows carry keys, never bytes), so
there is nothing cheap and honest to sum for a backfill. On an existing studio the counter therefore
starts at **0**: accounting starts at the version that ships this. The operator makes the number true by
running the reconcile, which rebuilds the ledger from the object store itself (through the Platform ICD
`list` + `head`, never a CF-specific usage API):

```
POST /api/storage/reconcile     # both panels; returns {objects, bytes, unsized}
GET  /api/storage/usage         # {used_bytes, quota_bytes, over, objects}
```

Run a reconcile when:

- the studio predates this version (the one-time backfill),
- an R2 lifecycle rule or an out-of-band delete removed objects (the counter reads HIGH),
- the log shows `storage-usage: failed to account ...` warnings (the counter reads LOW).

It is operator-invokable and never automatic: it is O(objects) list/head calls, so a boot-time sweep
would tax every cold start of every studio to fix a number that is usually already right.

`unsized` in the report is the count of objects the store would not report a size for. They are accounted
as 0 and reported honestly rather than folded into the total as a guess.

## Hosted vs self-host

Nothing in this feature is hosted-only. The hosted control plane sets `R2_STORAGE_QUOTA_BYTES` as a
plain-text var on the tenant Worker at provision; a self-hoster sets it in `.env`. Aggregate usage and
alerting across tenants is a control-plane concern (it is about OUR bill, not studio behavior) and reads
only; the enforcement is here, in the studio, where the write happens.
