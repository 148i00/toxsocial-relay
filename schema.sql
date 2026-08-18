CREATE TABLE IF NOT EXISTS profiles (
  pubkey TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  toxid TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  relay TEXT DEFAULT '',
  updated_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT DEFAULT '',
  sig TEXT DEFAULT '',
  PRIMARY KEY (pubkey, id)
);
CREATE INDEX IF NOT EXISTS idx_posts_ts ON posts(ts);

CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  desc TEXT DEFAULT '',
  host_toxid TEXT DEFAULT '',
  hosts TEXT DEFAULT '[]',
  members TEXT DEFAULT '[]',
  updated_at INTEGER DEFAULT 0
);
