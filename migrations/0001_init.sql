CREATE TABLE provisioning_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  source_ip TEXT,
  manufacturer TEXT,
  model TEXT,
  firmware TEXT,
  mac_address TEXT,
  http_method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_string TEXT,
  user_agent TEXT,
  headers_json TEXT NOT NULL
);

CREATE INDEX idx_provisioning_requests_mac ON provisioning_requests(mac_address);

CREATE TABLE zoom_s2s_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  account_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
