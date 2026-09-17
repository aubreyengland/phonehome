CREATE TABLE expected_devices (
  mac_address TEXT PRIMARY KEY,
  rc_device_id TEXT,
  name TEXT NOT NULL,
  extension TEXT,
  model TEXT,
  rc_status TEXT,
  imported_at TEXT NOT NULL
);
