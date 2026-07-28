# Storage accounting, `R2_STORAGE_QUOTA_BYTES` and `R2_STORAGE_QUOTA_MODE`

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

## The mode: what the number MEANS (cp#195)

| Var | Default | Meaning |
|---|---|---|
| `R2_STORAGE_QUOTA_MODE` | `deny` | `deny` = the bytes number is a HARD CEILING (everything above). `meter` = it is an INCLUDED QUOTA: nothing is refused, the studio surfaces used-vs-included, and whoever is billing meters the overage. Unset / empty / **unrecognised** = `deny`. |

`deny` is byte-identical to what core#52 shipped, so an existing studio changes nothing and no
migration is implied. `tests/storage-quota.test.ts` carries a CONTROL that drives every way of not
asking for `meter` through the same expectations and pins the exact message strings, so a drift in the
default is a test failure rather than something a reader has to notice.

**Why an unrecognised value means `deny` when unrecognised BYTES mean off.** That looks like an
inconsistency and is not one. For the bytes knob, garbage means nobody set a ceiling, so there is no
ceiling: absent knob, absent behaviour. For the mode, a studio that HAS a ceiling still has to pick an
enforcement posture, and there is no "no posture" to fall back to. `deny` is the conservative side:
guessing `meter` on a typo silently converts a hard stop into unmetered spend, which is the only
direction that costs somebody money they did not agree to. The fallback WARNS rather than throwing,
because refusing to boot over a mode string takes a studio down for a typo whose safe reading is
obvious, and going quiet leaves an operator believing they configured metering.

### In `meter` mode a broken read is a METERING GAP, not a zero

`meter` has no hard cap, so there is nothing to fail closed to; the `503` posture above is a `deny`
behaviour and is unreachable here. That makes the completeness of the reading load-bearing, because a
silently broken meter plus no cap is unbounded spend carried by whoever is billing.

Both `checkStorageQuota` and `storageQuotaState` therefore carry a pair:

| field | meaning |
|---|---|
| `complete: true` | a usable basis for billing. `usedBytes` is a real reading. |
| `complete: false` | a metering gap. `usedBytes` is `null`, `reason` says why in words, and the period is **UNBILLABLE**. Never zero overage. |

Read the pair together with `quotaBytes`, never one field alone: `quotaBytes === null` means no quota
is configured at all, which is a third state rather than an incomplete one. Before this flag existed
`{ ok: true, usedBytes: null }` was ALREADY the return for an unconfigured quota, so a failed read
would have been indistinguishable from a studio that never had a quota, and billed as zero. Those
three cases have a CONTROL asserting they stay pairwise distinguishable.

`overageBytes` follows the same rule: a real reading at or under the quota is `0`, never `null`.
"Nothing over" and "we do not know" are different answers.

### A readable total is not a TRUE total

`complete` asks one more question than "did the read succeed", and it has to. `storageUsedBytes()`
returns a confident integer on a studio whose ledger has never been reconciled, and that integer is
a **floor**:

- accounting starts at 0 on any studio that predates the version shipping it (see *Where the number
  comes from*), because artifact sizes are not derivable from the DB and there is nothing honest to
  backfill;
- a write the meter could not size or account leaves the counter reading LOW, with a warning;
- a delete it could not account leaves it reading HIGH, with a warning.

In `deny` mode a floor is nearly harmless: it denies later than a true total would. In `meter` mode
it is a billing defect, and in the direction that flatters the operator running the meter: under-count,
therefore under-bill, while the cost-recovery ratio reports health. Nothing downstream can catch it,
because a low number and a correct number are the same shape.

So the ledger records **when it started telling the truth**:

| call | what it means |
|---|---|
| `markStorageLedgerTrue(db, at?)` | this ledger is accurate as of `at`. Written by every successful `reconcileStorageUsage`, and callable by a HOST at studio creation. |
| `storageLedgerTrueSince(db)` | unix seconds, or `null` when it has never been established. |

`complete` is true only when the read succeeded AND the ledger is established. An unestablished
ledger still REPORTS its numbers (an operator staring at a usage page wants the floor rather than a
blank), and it reports `complete: false` with a reason saying the total is a floor.

**`deny` decisions are untouched by this rule**: a floor still denies at the ceiling, with the same
status and the same message. Only the advisory pair reports the weaker basis.

**Why "true since" and not "last reconciled".** A reconcile is one way a ledger becomes true; being
born with accounting already on is the other, and it covers every studio created from here. A host
that creates a studio at or after this version stamps it at creation, and the ledger is honest from
birth with no reconcile ever run. Naming the FACT rather than the procedure keeps both in one field.

**Why the table is created lazily.** Both panels carry `STORAGE_USAGE_DDL` verbatim with tests
asserting their migration still matches it, so a second DDL constant would put a migration in front
of this change in two more repos. `storage_usage_meta` is created where it is WRITTEN, and its
absence reads as "not established", which needs no migration and fails in the safe direction:
a studio that has never stamped anything is unbillable rather than billable-at-a-floor.
`STORAGE_LEDGER_META_DDL` is exported anyway, for a host that prefers a real migration.

**Operational consequence, stated plainly rather than discovered later:** until a host stamps at
creation or an operator runs a reconcile, `meter` mode reports every window unbillable. That is the
correct default. Billing off a floor is worse than not billing yet.

### The observer surface

`checkStorageQuota(env)` is the SUBMIT gate and runs on the render path. `storageQuotaState(env)` is
the read behind the usage route and the used-vs-included display, with no submit semantics attached:

```ts
{ mode, quotaBytes, usedBytes, objects, overageBytes, complete, reason }
```

ONE computation, deliberately. The alternative was for a hosted control plane to compute the billable
number its own way from its own object-store read, which means two numbers can disagree about the same
tenant and the one that bills is the one nobody can see. A self-hoster reads the identical fact off the
identical surface, which is the parity rule that put the quota in core to begin with.

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
