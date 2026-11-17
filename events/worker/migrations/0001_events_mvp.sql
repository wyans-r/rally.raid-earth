-- Rally Raid async events (MVP). Cloudflare D1 (SQLite). Apply with:
--   wrangler d1 migrations apply rallyraid-events --remote      (after the database is created; see DEPLOY.md)
-- Times are ISO-8601 UTC strings ('2026-11-20T18:00:00Z'). JSON columns hold JSON text.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,               -- email one-time-code login (lower case)
  discord_id    TEXT UNIQUE,               -- Discord login
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'entrant' CHECK (role IN ('entrant', 'organizer', 'admin')),
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,            -- SHA-256 of the cookie value (the cookie itself is never stored)
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,               -- SHA-256 of (secret + email + code)
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX login_codes_email ON login_codes(email, created_at);

CREATE TABLE oauth_states (
  state       TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE organizer_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TEXT NOT NULL,
  decided_by  TEXT,
  decided_at  TEXT
);

CREATE TABLE events (
  id                  TEXT PRIMARY KEY,
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  organizer_id        TEXT NOT NULL REFERENCES users(id),
  opens_at            TEXT NOT NULL,
  closes_at           TEXT NOT NULL,
  roadbook_release_at TEXT NOT NULL,       -- event packs (stage + roadbook) can be downloaded from then
  classes_json        TEXT NOT NULL,       -- ["T1 Prototype", "T3 Light", ...]
  rules_text          TEXT NOT NULL DEFAULT '',
  rules_json          TEXT NOT NULL DEFAULT '{}',   -- machine rules (game-crash resume penalties, max speed for checks, ...)
  min_mod_version     TEXT NOT NULL DEFAULT '0.2.0',
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked')),
  locked_at           TEXT,
  lock_hash           TEXT,                -- SHA-256 over every stage's published hashes (one number for the whole event)
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE event_stages (
  event_id        TEXT NOT NULL REFERENCES events(id),
  idx             INTEGER NOT NULL,        -- 1, 2, ... (SS1, SS2)
  name            TEXT NOT NULL,
  stage_id        TEXT NOT NULL,           -- the "id" inside the stage file
  length_km       REAL,
  waypoint_count  INTEGER,
  stage_sha256    TEXT NOT NULL,           -- of the exact stage file bytes stored in R2
  roadbook_sha256 TEXT,
  stage_bytes     INTEGER,
  roadbook_bytes  INTEGER,
  known_stage     INTEGER NOT NULL DEFAULT 0,   -- 1: an example / previously published stage ("known stage" label)
  known_reason    TEXT,
  PRIMARY KEY (event_id, idx)
);

CREATE TABLE entries (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  display_name  TEXT NOT NULL,
  class         TEXT NOT NULL,
  vehicle       TEXT,
  hc            INTEGER NOT NULL DEFAULT 0,   -- hors classement (the organizer, or anyone who authored a stage)
  key_version   INTEGER NOT NULL DEFAULT 1,   -- bump = every upload key in older packs stops working
  created_at    TEXT NOT NULL,
  UNIQUE (event_id, user_id)
);

CREATE TABLE results (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id),
  entry_id        TEXT NOT NULL REFERENCES entries(id),
  stage_idx       INTEGER NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,   -- 2+: an extra run of the same stage (flagged; the first one counts)
  received_at     TEXT NOT NULL,
  via             TEXT NOT NULL CHECK (via IN ('game', 'web')),
  package_key     TEXT NOT NULL,           -- R2 key of the package as received
  package_sha256  TEXT NOT NULL,
  package_bytes   INTEGER NOT NULL,
  stage_time      REAL,
  penalty_time    REAL,
  total_time      REAL,
  retired         TEXT,                    -- why the stage was retired (DNF), else NULL
  status          TEXT NOT NULL CHECK (status IN ('pass', 'flagged', 'approved', 'rejected')),
  checks_json     TEXT NOT NULL,           -- [{id, level, ok, msg}]
  review_penalty  REAL NOT NULL DEFAULT 0, -- seconds added by the organizer on review
  review_note     TEXT,
  reviewed_by     TEXT,
  reviewed_at     TEXT
);
CREATE INDEX results_event ON results(event_id, stage_idx, status);
CREATE INDEX results_entry ON results(entry_id, stage_idx);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  user_id  TEXT,
  action   TEXT NOT NULL,
  detail   TEXT
);

-- dev / test only: the email one-time codes "sent" when MAIL_MODE=outbox (never used in production)
CREATE TABLE dev_outbox (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  to_addr  TEXT NOT NULL,
  subject  TEXT NOT NULL,
  body     TEXT NOT NULL
);
