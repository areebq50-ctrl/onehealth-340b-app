# One.Health Partners — 340B Operations Platform

A full-stack internal web app for processing daily 340B pharmacy claims,
maintaining the master drug accumulator, and generating HRSA-ready reports.

**Stack:** React (Vite) + Tailwind CSS · Supabase (Postgres + Storage + Auth +
Edge Functions) · Vercel · Anthropic Claude API (proxied through an Edge
Function) · SheetJS (`xlsx`) · `pdfjs-dist` · `decimal.js` for all monetary
and quantity math.

## 1. Prerequisites

- Node.js 18+
- A Supabase project ([supabase.com](https://supabase.com))
- A Vercel account (for hosting)
- An Anthropic API key (for the AI Assistant)
- The [Supabase CLI](https://supabase.com/docs/guides/cli) (for deploying Edge Functions)

## 2. Set up Supabase

1. Create a new Supabase project.
2. In the Supabase SQL Editor, run `supabase/schema.sql` — this creates every
   table, enables Row Level Security with role-based policies, and creates
   the atomic RPC functions (`process_claim`, `edit_accumulator_row`,
   `rollover_month`, `add_accumulator_row`, `import_accumulator_rows`) that
   the app uses for every write that touches the accumulator.
3. Run `supabase/seed.sql` to create the default facility (Heartland) and
   pharmacies (Lawrence Hause, Blue Swan, Third Coast).
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

supabase functions deploy claude-assistant
supabase functions deploy admin-users

supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set SUPABASE_URL=https://<your-project-ref>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are used **only** inside the
Edge Functions to query the database with elevated privileges (e.g. to
invite users, or to gather AI-assistant context across all org data). They
are never sent to the browser. The Anthropic API key likewise never leaves
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
| `ANTHROPIC_API_KEY` | `claude-assistant` Edge Function only | **No** |
| `SUPABASE_URL` | Edge Functions only | **No** |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions only | **No** |
| `CLAUDE_MODEL` (optional, defaults to `claude-sonnet-4-6`) | `claude-assistant` Edge Function | **No** |

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
4. Deploy. Do **not** add `ANTHROPIC_API_KEY` or the Supabase service role
   key to Vercel — those belong only in Supabase Edge Function secrets.

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
- **AI Assistant**: `supabase/functions/claude-assistant` verifies the
  caller's Supabase session, runs a small set of heuristic queries against
  the database based on keywords in the question (month/date/pharmacy/drug
  name/"unmatched"/"expiring"), assembles a structured JSON context payload,
  and sends it to the Claude API. The system prompt instructs the model to
  only use the supplied data and never estimate figures.

## Project structure

```
src/
  lib/                  decimal.js math, NDC normalization, data cleaning,
                         Supabase API wrappers, Excel export
  parsers/               .xlsx raw-sheet parser + per-pharmacy PDF parsers
  pages/                 one file per sidebar route
  components/            layout, shared UI (DataTable, Modal, Toast, etc.)
  context/               Auth, Facility, Toast React contexts
supabase/
  schema.sql             tables, RLS policies, RPC functions
  seed.sql                default facility/pharmacies
  functions/
    claude-assistant/     AI Assistant Edge Function
    admin-users/           admin user-invite Edge Function
```

## Branding

The sidebar and login page use the real One.Health Partners logo, recreated
as SVG in `src/components/common/Logo.jsx` (`variant="full"` for the
wordmark, `variant="mark"` for the four-dot icon mark used as the favicon).
Swap the SVG markup there if the source logo files change.
