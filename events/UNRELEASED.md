# Async Events — unreleased

This folder is the start of online organised events (logins, event packs,
official results). It is **not public**.

- Do not deploy it.
- Do not add Events links to the public stage builder.
- The public mod zip leaves out the Rally Raid Event app and official.lua.
- Cloudflare D1 / R2 and login providers still need wyans' own approval
  before any real resources are created or any secrets are set.

Secrets (Discord client secret, Resend key, session secret, Cloudflare
token) belong in environment variables or `wrangler secret put`, never
in this folder. See the root `.env.example`.
