# Membership Management Platform

Static frontend + Supabase backend. No build step, no dependencies. **One portal**
(`index.html`): everyone signs in the same way; admins get an extra Admin tab.

## Members vs. hours-loggers

Anyone can sign up and **log volunteer hours right away** — you don't have to be
a member. Each signup auto-creates a person row. **Membership** is a flag
(`is_member`) an admin turns on; only then does the person's membership record
(status, type, renewal, tier, shirt) appear. So:

- **Just signed up** → can edit basic profile, browse events, log hours, see
  their own logged hours. A note says they aren't a member yet.
- **Admin flips `is_member` on** (and fills in membership details) → the
  membership panel appears for that person.

Nothing a person does to their own profile can grant them membership or admin;
those are admin-only fields.

## Setup

1. Create a Supabase project.
2. **SQL Editor** -> paste `supabase/schema.sql` -> Run.
3. **Authentication -> Sign In / Providers -> Email**: enable Email and allow
   new-user signups (so self-signup works).
4. **Authentication -> Emails -> Templates -> Magic Link**: add `{{ .Token }}` so
   users get a numeric code, not just a magic link.
5. Supabase URL + **publishable** key are kept out of the repo:
   - **GitHub Pages:** add repository secrets `SUPABASE_URL` and
     `SUPABASE_PUBLISHABLE_KEY`, and set **Settings → Pages → Source** to
     **GitHub Actions**. The workflow `.github/workflows/deploy-pages.yml` writes
     `public/env.js` from the secrets on every deploy.
   - **Local:** copy `public/env.example.js` to `public/env.js` and fill it in
     (git-ignored), then run
     `python3 -m http.server --directory public 8080` -> open `index.html`.
   - **Other hosts (Netlify, Cloudflare Pages):** generate `public/env.js` in a build
     command from that host's environment variables, the same way the workflow does.

## Setting up the FIRST admin

Signing in auto-creates your (non-member, non-admin) person row. Promote it once
in SQL:

1. Open the portal and **sign in once with your email** (enter the code).
2. In Supabase **SQL Editor**, run (edit the email):
   ```sql
   update public.members
      set is_admin = true, is_member = true, membership_status = 'active'
    where lower(email) = lower('you@example.org');
   ```
3. **Reload the portal.** You now have the **Admin** tab. From there you manage
   everyone in the UI — no more SQL.

## Admin: People

- Roster shows everyone with an **Is member** column; search, click-to-sort.
- Bulk CSV import (template includes an `is_member` column), two CSV exports
  (people / hours; the hours export flags whether each logger is a member).
- Create/edit a person; tick **Is member** to make them a member.
- Log hours for anyone (member or not), including type-ahead bulk logging.

## Security notes

- Only the **publishable** key (`sb_publishable_...`) belongs in the browser. Never ship
  the secret key (`sb_secret_...`) or the legacy service_role key.
- Keeping the publishable key in GitHub secrets keeps it out of the repo, but it is still
  visible to anyone using the live site (browser DevTools). That's expected; RLS is what
  protects the data.
- Access control lives in RLS + SECURITY DEFINER RPCs; UI is convenience only.
