export interface Env {
  DB: D1Database;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  ENCRYPTION_KEY: string;
}

export interface ParsedDevice {
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  macAddress: string | null;
}
