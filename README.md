# One.Health Partners — 340B Operations Platform

A full-stack internal web app for processing daily 340B pharmacy claims,
maintaining the master drug accumulator, and generating HRSA-ready reports.

**Stack:** React (Vite) + Tailwind CSS · Supabase (Postgres + Storage + Auth +
Edge Functions) · Vercel · Groq API (proxied through an Edge Function) ·
SheetJS (`xlsx`) · `pdfjs-dist` · `decimal.js` for all monetary and quantity
math.

## 1. Prerequisites

- Node.js 18+
- A Supabase project ([supabase.com](https://supabase.com))
- A Vercel account (for hosting)
- A Groq API key, free tier ([console.groq.com/keys](https://console.groq.com/keys)) (for the AI Assistant)
- The [Supabase CLI](https://supabase.com/docs/guides/cli) (for deploying Edge Functions)

## 2. Set up Supabase

1. Create a new Supabase project.
2. In the Supabase SQL Editor, run `supabase/schema.sql` — this is the
   single consolidated source of truth: all tables (including the
   pharmacy-scoped accumulator and RX-level claim ledger), RLS policies, and
   RPC functions. It's idempotent (safe to re-run on the same project if you
   need to reapply it). See "Pharmacy scoping" below for why pharmacy-level
   scoping matters.
3. Run `supabase/seed.sql` to create the default facility (Heartland) and
   pharmacies (Lawrence House, Blue Swan, Third Coast).
4. In **Authentication → Providers**, ensure Email is enabled.
5. Create your first admin user:
   - Add the user via **Authentication → Users → Add User** (or have them
     sign up). A `public.users` row is auto-created with `role='regular'`
     via a database trigger.
   - Promote them to admin:
     ```sql
     update public.users set role = 'admin' where email = 'you@onehealthpartners.com';
     ```
6. Deploy the Edge Functions (see below) and set their secrets.

### Deploying Edge Functions

```bash
supabase login
supabase link --project-ref <your-project-ref>

supabase functions deploy ai-assistant
supabase functions deploy admin-users

supabase secrets set GROQ_API_KEY=gsk_...
supabase secrets set SUPABASE_URL=https://<your-project-ref>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are used **only** inside the
Edge Functions to query the database with elevated privileges (e.g. to
invite users, or to gather AI-assistant context across all org data). They
are never sent to the browser. The Groq API key likewise never leaves
the Edge Function.

## 3. Environment variables

Copy `.env.example` to `.env` and fill in your Supabase project's public
credentials:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

These are safe to expose to the browser — access control is enforced by the
Postgres Row Level Security policies in `supabase/schema.sql`, not by
keeping the anon key secret.

| Variable | Where it's used | Exposed to browser? |
|---|---|---|
| `VITE_SUPABASE_URL` | Frontend (Vite) | Yes |
| `VITE_SUPABASE_ANON_KEY` | Frontend (Vite) | Yes |
| `GROQ_API_KEY` | `ai-assistant` Edge Function only | **No** |
| `SUPABASE_URL` | Edge Functions only | **No** |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions only | **No** |
| `GROQ_MODEL` (optional, defaults to `llama-3.3-70b-versatile`) | `ai-assistant` Edge Function | **No** |

## 4. Run locally

```bash
npm install
npm run dev
```

The app runs at `http://localhost:5173`.

## 5. Deploy to Vercel

1. Push this repo to GitHub.
2. In Vercel, import the repo. `vercel.json` already configures the Vite
   build (`npm run build`, output directory `dist`, SPA rewrites).
3. In the Vercel project's **Settings → Environment Variables**, add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy. Do **not** add `GROQ_API_KEY` or the Supabase service role
   key to Vercel — those belong only in Supabase Edge Function secrets.

## 6. Ownership handoff / continuity

This app was built by an intern, for a hand-off to a permanent owner
before the internship ends. There is no special "connector" between any
particular AI coding tool and this repo — anyone (or any Claude Code
session) with the access below can pick up exactly where the last person
left off, because everything durable lives in this repo, the Supabase
project, and the deployment — not in any one person's account or any one
chat conversation.

**Three things need an owner who isn't a departing intern:**

1. **GitHub repo** — transfer ownership (Settings → Danger Zone) or add
   the new owner as a collaborator/org member with admin rights.
2. **Supabase project** — add the new owner as an Owner of the Supabase
   Organization this project lives in. The project itself (URL, keys)
   doesn't need to change — only who has access to it.
3. **Vercel project** — same idea: add the new owner to the Vercel
   project/team. Verify its GitHub integration still has access if the
   repo's location changes.

None of the above requires touching any API keys or env vars — those live
with the Supabase/Vercel projects themselves, not with whoever's logged in.
The **one exception**: `GROQ_API_KEY` (see `.env.example`) is a personal
key from whoever signed up at console.groq.com — if that was a personal
account rather than the company's, it can stop working once that person's
access lapses, even though nothing else about the app changes. Check this
before an ownership handoff completes.

**The one manual step that never automates**: nobody (not even this AI
assistant, across this entire project) has ever had direct database
execution access to the live Supabase project. Every change to
`supabase/schema.sql` is inert until someone actually pastes it into the
Supabase SQL Editor and runs it — pulling the latest code from GitHub does
**not** update the live database by itself. If a "function not found" or
"column does not exist" error ever shows up after pulling new code, this
is almost always why — re-run `schema.sql` (it's idempotent, safe to
re-run anytime) before assuming it's a real bug.

`supabase/migration_flip_sign_convention.sql` and
`supabase/cleanup_lawrence_house_july_2026.sql` are **one-time** scripts,
already run — they're kept in the repo for a historical record, not meant
to be re-run. Only `schema.sql` needs re-running after a pull.

**Known data quirk to watch for**: source accumulator Excel exports have
occasionally had a wrong Pack Size baked into the file itself for one NDC
(seen for Tretinoin, NDC 62332080920 — Pack Size stored as 1 instead of
20). This is a typo in the source file, not an app bug, and will keep
reappearing on every re-import of that file until corrected at the source
(or manually edited in the Accumulator page's Actions column) after each
import.

## Architecture notes

- **All monetary/quantity math uses `decimal.js`** (`src/lib/calculations.js`).
  Native JS `+ - * /` are never used on money, quantity, packs, or inventory
  values anywhere in the frontend. Server-side, Postgres `numeric` is
  exact-precision decimal arithmetic, so the RPC functions in `schema.sql`
  are equally safe.
- **NDC normalization** (`src/lib/ndc.js`) strips dashes/spaces and
  left-pads to 11 digits. It's applied to both the claim data and the
  accumulator before any cross-reference — joins are always NDC-to-NDC,
  never on drug name.
- **Atomic writes**: every operation that touches the accumulator (claim
  processing, overwrite/reversal, inline edits, month rollover, imports)
  goes through a `SECURITY DEFINER` Postgres RPC function whose body is a
  single transaction — any error rolls back every write it made. The
  frontend never issues separate calls to update the claim, line items,
  accumulator, and audit log independently.
- **RLS**: every table has Row Level Security enabled. `claims`,
  `claim_line_items`, `accumulator_audit_log`, and
  `accumulator_field_edit_log` have no client-facing INSERT/UPDATE/DELETE
  policies — all writes to them happen exclusively through the RPC
  functions, which run with the owning role's privileges. Historical
  accumulator periods (anything but the latest month/year per facility) are
  blocked from direct writes at the RLS layer.
- **Insert-only audit trail**: `accumulator_audit_log` and
  `accumulator_field_edit_log` have RLS policies for INSERT and SELECT only
  — no UPDATE or DELETE policy exists for any role, so the audit trail is
  immutable at the database level.
- **AI Assistant**: `supabase/functions/ai-assistant` verifies the
  caller's Supabase session, runs a small set of heuristic queries against
  the database based on keywords in the question (month/date/pharmacy/drug
  name/"unmatched"/"expiring") *and* the app's currently-selected
  Facility/Pharmacy scope (passed from the frontend), assembles a structured
  JSON context payload, and sends it to the Groq API. The system prompt
  instructs the model to only use the supplied data and never estimate
  figures, and never sum figures across pharmacies unless asked.

## Pharmacy scoping

Every accumulator row, claim, audit log entry, and report belongs to
exactly one pharmacy — a Blue Swan claim can never deduct from Lawrence
House's inventory even for the same NDC on the same day. This is enforced
at every layer, not just in the UI:

- **Schema**: `accumulator` is keyed on `(ndc, facility_id, pharmacy_id, month, year)`.
  A `validate_pharmacy_facility_pair` trigger rejects any row where the
  facility/pharmacy pair isn't a real link in `pharmacy_facilities`.
- **RPCs**: `process_claim`, `edit_accumulator_row`, `add_accumulator_row`,
  `rollover_month`, and `import_accumulator_rows` all require a specific
  `pharmacy_id` and only ever read/write that pharmacy's rows.
- **RLS**: direct writes to `accumulator` are blocked outside the latest
  period *for that specific pharmacy* — a closed month for Blue Swan stays
  closed even if Lawrence House is still open.
- **Frontend**: `FacilityContext` (`src/context/FacilityContext.jsx`) is the
  single source of truth for the selected facility/pharmacy across every
  page, persisted to `localStorage`. Changing facility clears an
  invalid pharmacy selection automatically. "All Pharmacies" is a
  read-only aggregate view everywhere it appears — every write action is
  disabled until one specific pharmacy is selected.

### Claim batches, the RX-level ledger, and replenishment

`claims` is the "claim batch" record (one per pharmacy/facility/date
upload). Two child tables capture different granularities of the same
upload:

- `claim_line_items` — one row **per NDC**, pivoted/summed. This is what
  drives accumulator deduction, reimbursement, and the audit log.
- `claim_raw_lines` — one row **per original source line** (per RX fill),
  preserving every column from the source workbook (Refill No., RX#, Date
  Filled/Written, payer/BIN/PCN/prescriber, etc.) for the "All Claims" tab.
  It's pure record-keeping and never touches the accumulator.

**Replenishment** (`packsToOrder()` in `src/lib/calculations.js`) is
computed at read time from `qty_after` (or the live `accumulator.qty_on_hand`)
and `.pack_size` — never stored — so it can't drift out of sync with the
source numbers it's derived from.

**Sign convention** (confirmed directly with the pharmacy team — this is
the single convention used everywhere: the database, every RPC, every UI
screen): the balance is **deficit-framed**, not a raw physical count.
POSITIVE = a shortage (this many units short, needs ordering). NEGATIVE =
surplus (this many units of extra stock on hand). A claim dispense ADDS
toward shortage; an order received (invoice upload) SUBTRACTS toward
surplus.

The replenishment rule (confirmed against the pharmacy's own master
spreadsheet — floors, and only orders once a shortfall reaches a full
pack):

```
Shortage    = max(0, qtyAfter)             (only when the balance went positive/short)
Exact Packs = Shortage ÷ Pack Size         (shown as-is, e.g. 1.25 — never rounded)
Recommended = floor(Exact Packs)           (a partial pack, e.g. 0.7, is NOT ordered yet — it carries forward)
```

A row only appears on an order list once `Recommended >= 1`. If your
actual purchasing policy ever changes, `packsToOrder()` is the one function
to edit — its docstring has worked examples.

### Excel preview

`ExcelPreviewModal` (`src/components/files/ExcelPreviewModal.jsx`) fetches
a short-lived Supabase Storage **signed URL** (the `claim-files` bucket is
private — never a public URL) and parses it client-side with SheetJS.
Sheets are capped at 500 previewed rows to keep the browser responsive; a
banner explains when a sheet was truncated, and "Download Original File"
always gets the full file. The preview never mutates the stored file.

## Project structure

```
src/
  lib/                   decimal.js math (incl. packsToOrder), NDC normalization,
                          data cleaning, Supabase API wrappers, Excel export
  parsers/                .xlsx raw-sheet parser + per-pharmacy PDF parsers
  pages/                  one file per sidebar route (Dashboard, UploadClaims,
                          ClaimSearch, ClaimBatchResults, Accumulator, Reports,
                          AIAssistant, Settings)
  components/
    common/                layout-agnostic shared UI: DataTable, Modal, Toast,
                          FacilityPharmacySelector, ScopeLabel, etc.
    files/                 ExcelPreviewModal
  context/                Auth, Facility (facility+pharmacy scope), Toast
supabase/
  schema.sql              consolidated tables, RLS policies, RPC functions
                          (single source of truth — idempotent, safe to re-run)
  seed.sql                 default facility/pharmacies
  functions/
    ai-assistant/           AI Assistant Edge Function
    admin-users/            admin user-invite Edge Function
```

## Branding

The sidebar and login page use the real One.Health Partners logo, recreated
as SVG in `src/components/common/Logo.jsx` (`variant="full"` for the
wordmark, `variant="mark"` for the four-dot icon mark used as the favicon).
Swap the SVG markup there if the source logo files change.
