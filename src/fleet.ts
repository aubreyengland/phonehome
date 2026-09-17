import { strFromU8, unzipSync } from 'fflate';
import { normalizeMac } from './parse.ts';

/** One row of the RingCentral device export that we expect to see check in. */
export interface ExpectedDevice {
  macAddress: string;
  rcDeviceId: string | null;
  name: string;
  extension: string | null;
  model: string | null;
  rcStatus: string | null;
}

const REQUIRED_COLUMNS = ['Name', 'Type', 'Serial/MAC'] as const;

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function textOf(xml: string): string {
  return decodeXml(Array.from(xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g), (m) => m[1] ?? '').join(''));
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return Array.from(xml.matchAll(/<si>([\s\S]*?)<\/si>/g), (m) => textOf(m[1] ?? ''));
}

/** Returns each row as a map of column letter -> cell text. */
function parseSheetRows(xml: string, shared: string[]): Map<string, string>[] {
  const rows: Map<string, string>[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<string, string>();
    for (const cell of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const body = cell[2] ?? '';
      const column = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      if (!column) continue;
      const type = attrs.match(/\bt="(\w+)"/)?.[1];
      let value: string;
      if (type === 'inlineStr') {
        value = textOf(body);
      } else if (type === 's') {
        const index = Number(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? -1);
        value = shared[index] ?? '';
      } else {
        value = decodeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      }
      cells.set(column, value.trim());
    }
    rows.push(cells);
  }
  return rows;
}

function nullable(value: string | undefined): string | null {
  return value ? value : null;
}

/**
 * Parses the RingCentral "Devices" export. Keeps only `Type = HardPhone` rows whose
 * `Serial/MAC` is a real MAC — softphones, paging, and ATAs with vendor serials are skipped.
 */
export function parseMigrateWorkbook(bytes: Uint8Array): ExpectedDevice[] {
  const files = unzipSync(bytes);
  const sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) {
    throw new Error('workbook has no xl/worksheets/sheet1.xml');
  }
  const sharedFile = files['xl/sharedStrings.xml'];
  const shared = parseSharedStrings(sharedFile ? strFromU8(sharedFile) : undefined);
  const [headerRow, ...dataRows] = parseSheetRows(strFromU8(sheet), shared);

  const columnFor = new Map<string, string>();
  for (const [column, header] of headerRow ?? []) {
    columnFor.set(header, column);
  }
  const missing = REQUIRED_COLUMNS.filter((header) => !columnFor.has(header));
  if (missing.length > 0) {
    throw new Error(`workbook header row is missing required columns: ${missing.join(', ')}`);
  }
  const get = (row: Map<string, string>, header: string): string | undefined => {
    const column = columnFor.get(header);
    return column ? row.get(column) : undefined;
  };

  const devices: ExpectedDevice[] = [];
  for (const row of dataRows) {
    if (get(row, 'Type') !== 'HardPhone') continue;
    const macAddress = normalizeMac(get(row, 'Serial/MAC') ?? '');
    if (!macAddress) continue;
    devices.push({
      macAddress,
      rcDeviceId: nullable(get(row, 'Device ID')),
      name: get(row, 'Name') ?? '',
      extension: nullable(get(row, 'Extension Number')),
      model: nullable(get(row, 'Model')),
      rcStatus: nullable(get(row, 'Status')),
    });
  }
  return devices;
}

function sqlString(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`;
}

/** One upsert statement per device, terminated with `;\n` for `wrangler d1 execute --file`. */
export function buildSeedSql(devices: ExpectedDevice[], importedAt: string): string {
  return devices
    .map(
      (d) =>
        `INSERT INTO expected_devices (mac_address, rc_device_id, name, extension, model, rc_status, imported_at) VALUES (` +
        [d.macAddress, d.rcDeviceId, d.name, d.extension, d.model, d.rcStatus, importedAt].map(sqlString).join(', ') +
        `) ON CONFLICT(mac_address) DO UPDATE SET rc_device_id = excluded.rc_device_id, name = excluded.name, ` +
        `extension = excluded.extension, model = excluded.model, rc_status = excluded.rc_status, imported_at = excluded.imported_at;\n`,
    )
    .join('');
}
