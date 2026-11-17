# Setting up the two login methods (plain-language guide for Wyans)

Entrants log in one of two ways. Neither uses a password:

- **Email code.** They type their email address. The site emails them a 6-digit code, and they type the code in.
- **Discord.** They press "Log in with Discord" and approve it on Discord's own page.

Both are already built and tested on a local copy of the site. Each one needs an account with an outside service
before it works on the real site. Each setup takes about 10–15 minutes. You do the clicking; the secret values go into
Grok Bot's masked entry box, never into a chat.

---

## A. Discord login (about 10 minutes)

What it is: Discord calls the website an "application". You register one, and Discord gives you two values:

- the **Application ID**, which is public;
- the **Client Secret**, which is private, like a password.

1. Log in at https://discord.com/developers/applications with your Discord account.
2. Click **New Application**, name it **Rally Raid Events**, tick the terms box and click **Create**.
3. Optional: on **General Information**, add an icon and a description. Entrants see these on the approve page.
4. In the left menu, open **OAuth2**.
   - Copy the **Client ID**. This is the Application ID and it's fine to share.
   - Under **Client Secret**, click **Reset Secret** and copy the value. Discord shows it only once.
5. Still on **OAuth2**, under **Redirects**, click **Add Redirect** and paste exactly:
   `https://stagebuilder.wyans.net/api/auth/discord/callback`
   Then click **Save Changes**.
6. Give Grok Bot the two values:
   - the **Client ID** can go in chat, because it's public;
   - the **Client Secret** goes only into the masked entry box.

The site asks Discord for the "identify" permission only. That means the user name and user ID: no email, no
servers, no messages.

Optional: to be admin when you log in with Discord, give Grok Bot your Discord **User ID**. Get it in Discord under
Settings → Advanced → turn on Developer Mode, then right-click your name → Copy User ID.

---

## B. Email codes through Resend (about 15 minutes, plus waiting for DNS)

What it is: the website can't send email by itself, so it uses a mail service called **Resend**. The free plan
allows 3,000 emails a month and 100 a day, which is plenty for login codes. Resend only sends mail from a domain
whose ownership you've proved. You prove it by adding a few DNS records to wyans.net at Cloudflare.

1. Sign up at https://resend.com with your email.
2. Go to **Domains** → **Add Domain**.
   - Domain: `wyans.net`. Resend may suggest a subdomain such as `mail.wyans.net`. Either works; a subdomain keeps your
     main domain's mail settings untouched.
   - Region: **us-east-1**, the closest to you.
3. Resend shows 3–4 DNS records. They're type **TXT** and **MX**, named something like `resend._domainkey`, `send` and
   `_dmarc`. Add them in Cloudflare: **wyans.net → DNS → Records → Add record**.
   - Copy each name and value exactly.
   - Leave **Proxy status** on **DNS only** (grey cloud).
   - Or ask Grok Bot to add them. That needs an API token with "Zone DNS Edit" rights on wyans.net. The current token
     can't do it.
   - Resend also offers an automatic Cloudflare button. That's fine to use too.
4. Back in Resend, click **Verify DNS Records**. It usually turns green within minutes, but can take up to a few hours.
5. Go to **API Keys** → **Create API Key**.
   - Name: `stagebuilder`.
   - Permission: **Sending access**.
   - Domain: wyans.net.
   - Copy the key. It starts with `re_`, and Resend shows it only once.
6. Give Grok Bot the key through the **masked entry box only**. Also say which sender address you want, for example
   `events@wyans.net`. Nobody has to read that mailbox; replies to it can simply go nowhere.

---

## C. What Grok Bot does with these (no action from you)

Each private value is stored as an encrypted Worker secret, never in a file:

    wrangler secret put DISCORD_CLIENT_SECRET
    wrangler secret put RESEND_API_KEY
    wrangler secret put SESSION_SECRET      (a long random value Grok Bot generates)

The public settings go in the config file:

- `DISCORD_CLIENT_ID`
- `MAIL_FROM`
- `ADMIN_EMAILS`, which is your email and makes you admin when you log in with it

You can launch with only one method switched on. For example, `AUTH_PROVIDERS = "discord"` while the Resend domain is
still verifying.
