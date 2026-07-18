# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**. WHOOP is an optional add-on.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **password screen** — the default password is in
[`lock.js`](lock.js) (`var PASSWORD = "qwer"`). Change it to whatever you want.

---

## 2. Supabase (cross-device sync) — required for sync

Create a free project at **supabase.com**, then run **both** SQL blocks in
**SQL Editor → New query → Run**.

### SQL #1 — `app_state` (all dashboard sync)
```sql
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The browser uses the ANON key, so allow it to read/write:
alter table public.app_state enable row level security;
create policy "anon full access app_state"
  on public.app_state for all
  to anon using (true) with check (true);

-- Instant cross-device updates:
alter publication supabase_realtime add table public.app_state;
```

### SQL #2 — progress-photo sync (Storage bucket)
Progress photos upload to a Supabase **Storage** bucket called `progress-photos` (only the
image URLs sync through `app_state`). Skip this if you don't need photos to sync across devices.
```sql
insert into storage.buckets (id, name, public)
values ('progress-photos', 'progress-photos', true)
on conflict (id) do nothing;

create policy "anon manage progress-photos"
  on storage.objects for all
  to anon
  using (bucket_id = 'progress-photos')
  with check (bucket_id = 'progress-photos');
```

### Connect YOUR Supabase — pick ONE way
Supabase → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key.

**Way A — Vercel env vars (easiest, no code edits):**
In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

Redeploy. The app reads these automatically via `/api/config`.

**Way B — edit the files:**
Replace the old URL/key in these files:
- [`sync.js`](sync.js)
- [`topbar.js`](topbar.js)
- [`gym.html`](gym.html)

> ⚠️ Only the **anon** key (public) is used here. **Never** put the `service_role` key in code
> or in these env vars.

---

## 3. WHOOP (optional)

1. **developer.whoop.com** → create an app.
2. Set its **Redirect URI** to exactly: `https://your-app.vercel.app/api/whoop-callback`
   (use your real Vercel domain — add every domain you'll open the site from).
3. Put your app's **Client ID** in [`health.html`](health.html) (`const CLIENT_ID = '...'`),
   and add these in Vercel → **Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `WHOOP_CLIENT_ID` | your WHOOP app's Client ID |
| `WHOOP_CLIENT_SECRET` | your WHOOP app's Client Secret (**secret**) |

4. Open the site at that exact domain → Health page → **Connect WHOOP**.

> The callback auto-detects the domain, so you do **not** need a `WHOOP_REDIRECT_URI` env var.

---

## 4. Nova (AI mentor / gym coach / money coach) — optional

Nova (chat, and finance's receipt scanner) calls Claude through serverless functions
(`api/nova.js`, `api/receipt.js`, and `gym.html`'s inline widget) so the Anthropic key
stays server-side — no one has to paste their own key. Add in Vercel →
**Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic API key (console.anthropic.com) |

---

## 5. Daily Steps (optional, via Apple Health + Shortcuts)

WHOOP doesn't track steps (see [WHOOP 101](https://developer.whoop.com/docs/whoop-101/)), so the
Steps card on the gym page instead reads from a Supabase table that an **iOS Shortcuts
automation** posts into from your phone's Health data. This app never writes to it — it's
read-only display + a realtime subscription.

### SQL #3 — `daily_steps`
Run this in Supabase **SQL Editor** the same way as SQL #1/#2 above:
```sql
create table if not exists public.daily_steps (
  date       date primary key,
  steps      integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.daily_steps enable row level security;
create policy "anon full access daily_steps"
  on public.daily_steps for all
  to anon using (true) with check (true);

alter publication supabase_realtime add table public.daily_steps;
```

### Build the Shortcut (on your iPhone, in the Shortcuts app)
1. **Shortcuts app → +** to create a new shortcut. Name it e.g. "Sync Steps".
2. Add action **Get Health Sample** → type **Steps**, range **Today**. Set it to sum/combine
   samples so you get one total number.
3. Add action **Get Contents of URL**:
   - URL: `https://<your-project-ref>.supabase.co/rest/v1/daily_steps` (your Supabase Project URL + `/rest/v1/daily_steps`)
   - Method: **POST**
   - Headers:
     | Key | Value |
     |---|---|
     | `apikey` | your Supabase anon/publishable key |
     | `Authorization` | `Bearer <same anon key>` |
     | `Content-Type` | `application/json` |
     | `Prefer` | `resolution=merge-duplicates` |
   - Request Body (JSON): `{ "date": "<today's date, YYYY-MM-DD>", "steps": <the Health sample from step 2> }`
     — build the date with a **Format Date** action (format `yyyy-MM-dd`) feeding into the JSON body, and the steps number from step 2's result.
4. **Automation tab → + → Personal Automation → Time of Day**, repeat hourly (or whatever cadence
   you want — this is how "live" the dashboard number feels), **Run Immediately** (turn off "Ask
   Before Running" so it's silent).
5. Open the gym page once after your first sync to confirm the Steps card fills in.

---

## 6. Plaid (linked bank accounts — finance.html) — optional

Connects real banks (Wells Fargo, etc.) via Plaid Link to show live balances, credit
cards and debt in the **Linked accounts** card on the Net Worth tab.

1. **SQL** — run in Supabase **SQL Editor** (this table is deliberately **not** covered
   by the `app_state` policy above — it has no anon policy at all, so only the
   `service_role` key used by the serverless functions can read/write it):
   ```sql
   create table if not exists public.plaid_items (
     id                uuid primary key default gen_random_uuid(),
     item_id           text unique not null,
     access_token      text not null,
     institution_name  text,
     created_at        timestamptz not null default now()
   );
   alter table public.plaid_items enable row level security;
   -- No policy added on purpose: RLS default-denies the anon key entirely.
   -- The service_role key (server-side only) bypasses RLS by design.
   ```

2. **Get Plaid keys** — create an app at **dashboard.plaid.com**. Copy your
   **Client ID** and the **Secret** for whichever environment you're using
   (`sandbox` is free and uses fake test banks; apply for **Production** access
   from the Plaid dashboard when you're ready to connect a real Wells Fargo account —
   approval is usually same-day for personal use).

3. **Get your Supabase service role key** — Supabase → **Project Settings → API** →
   copy the **`service_role`** key (⚠️ this is a secret — it bypasses RLS, unlike
   the anon key used everywhere else in this app. Only ever put it in a Vercel env
   var, never in a file that gets committed).

4. In Vercel → **Settings → Environment Variables**, add:

   | Variable | Value |
   |---|---|
   | `PLAID_CLIENT_ID` | your Plaid app's Client ID |
   | `PLAID_SECRET` | your Plaid app's Secret (**secret**) |
   | `PLAID_ENV` | `sandbox` or `production` (defaults to `sandbox` if unset) |
   | `SUPABASE_SERVICE_ROLE_KEY` | your Supabase `service_role` key (**secret**) |

5. Redeploy → open **Finances → Net Worth** → **Linked accounts** card →
   **Connect a bank**.

> ⚠️ **This dashboard currently has no passcode lock** — `lock.js` (referenced by every
> page's `<script src="lock.js">`) was deleted from the repo, so the password screen
> described in step 1 doesn't actually run right now. That was a low-stakes gap before;
> once you link a real bank account, anyone who finds your Vercel URL can view (and
> disconnect) it. Recreate `lock.js` with a real password before connecting production
> bank data, or ask for a fresh one to be built.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. (Optional) WHOOP: Client ID in `health.html` + the two env vars in Vercel.
4. (Optional) Nova: `ANTHROPIC_API_KEY` env var in Vercel.
5. (Optional) Steps: SQL #3 + the Shortcuts automation above.
6. (Optional) Plaid: run the `plaid_items` SQL, then the four Plaid/Supabase
   service-role env vars in Vercel.
7. Recreate `lock.js` with a real password before this holds real bank data — it's
   currently missing from the repo. Done.
