CREATE TABLE blocked_ips (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_path TEXT
);
