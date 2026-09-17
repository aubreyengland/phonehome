CREATE TABLE provisioning_profiles (
  model TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  zoom_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE zoom_devices (
  mac_address TEXT PRIMARY KEY,
  zoom_device_id TEXT NOT NULL,
  display_name TEXT,
  device_type TEXT,
  assignee TEXT,
  status TEXT,
  raw_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE provisioning_requests ADD COLUMN response_status INTEGER;
ALTER TABLE provisioning_requests ADD COLUMN response_kind TEXT;
ALTER TABLE provisioning_requests ADD COLUMN response_reason TEXT;
