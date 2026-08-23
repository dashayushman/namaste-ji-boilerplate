-- cards — the example agent's table. One row per generated card.
CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  day         TEXT NOT NULL,                     -- YYYY-MM-DD (UTC)
  title       TEXT NOT NULL,
  line        TEXT NOT NULL,
  provider    TEXT NOT NULL,                     -- which provider wrote it (from KV config)
  model_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cards_day ON cards(day);
