import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildSeedSql, parseMigrateWorkbook, type ExpectedDevice } from '../src/fleet.ts';

const HEADERS = ['Action', 'Device ID', 'Name', 'Extension Number', 'Type', 'Model', 'Serial/MAC', 'Status'];
const COLS = 'ABCDEFGH';

type Cell = string | number | null;

function inlineCell(ref: string, value: Cell): string {
  if (value === null) return `<c r="${ref}" s="1"/>`;
  if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
}

/** Builds a one-sheet xlsx the way openpyxl does (inline strings, no sharedStrings). */
function inlineWorkbook(rows: Cell[][]): Uint8Array {
  const allRows = [HEADERS, ...rows];
  const xmlRows = allRows
    .map((cells, r) => `<row r="${r + 1}">${cells.map((c, i) => inlineCell(`${COLS[i]}${r + 1}`, c)).join('')}</row>`)
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`;
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) });
}

/** Builds a one-sheet xlsx the way Excel does (strings via sharedStrings.xml). */
function sharedStringWorkbook(rows: Cell[][]): Uint8Array {
  const strings: string[] = [];
  const idx = (s: string) => {
    let i = strings.indexOf(s);
    if (i === -1) i = strings.push(s) - 1;
    return i;
  };
  const allRows = [HEADERS, ...rows];
  const xmlRows = allRows
    .map((cells, r) => {
      const xml = cells
        .map((c, i) => {
          const ref = `${COLS[i]}${r + 1}`;
          if (c === null) return `<c r="${ref}"/>`;
          if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
          return `<c r="${ref}" t="s"><v>${idx(c)}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${xml}</row>`;
    })
    .join('');
  const sheet = `<worksheet><sheetData>${xmlRows}</sheetData></worksheet>`;
  const sst = `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet), 'xl/sharedStrings.xml': strToU8(sst) });
}

const yealink: Cell[] = ['IGNORE', 800518555006, 'Jessie Christy', 53265, 'HardPhone', 'Yealink T48S', '805ec0aabbcc', 'Online'];
const polyNoExt: Cell[] = ['IGNORE', '800518556006', 'Hot Desk Phone - Polycom VVX411', null, 'HardPhone', 'Polycom VVX411', '64167F4B6C10', 'Offline'];
const softphone: Cell[] = ['IGNORE', '800518557006', 'Some User', '2630', 'SoftPhone', null, 'VDI-CATTECH13', 'Online'];
const ciscoAta: Cell[] = ['IGNORE', '800518558006', 'Fax line', '2631', 'HardPhone', 'Cisco SPA-122 ATA', 'CCQ224502A7', 'Offline'];
const unprovisioned: Cell[] = ['IGNORE', '800518559006', 'Spare T48U', null, 'HardPhone', 'Yealink T48U Ultra-elegant Gigabit IP Phone', null, 'Offline'];

describe('parseMigrateWorkbook', () => {
  it('maps hard phones with a MAC from an inline-string workbook', () => {
    const devices = parseMigrateWorkbook(inlineWorkbook([yealink, polyNoExt]));
    expect(devices).toEqual<ExpectedDevice[]>([
      {
        macAddress: '80:5E:C0:AA:BB:CC',
        rcDeviceId: '800518555006',
        name: 'Jessie Christy',
        extension: '53265',
        model: 'Yealink T48S',
        rcStatus: 'Online',
      },
      {
        macAddress: '64:16:7F:4B:6C:10',
        rcDeviceId: '800518556006',
        name: 'Hot Desk Phone - Polycom VVX411',
        extension: null,
        model: 'Polycom VVX411',
        rcStatus: 'Offline',
      },
    ]);
  });

  it('reads the same data from a shared-string workbook', () => {
    expect(parseMigrateWorkbook(sharedStringWorkbook([yealink]))).toEqual(
      parseMigrateWorkbook(inlineWorkbook([yealink])),
    );
  });

  it('skips softphones, non-MAC serials, and hard phones with no serial', () => {
    const devices = parseMigrateWorkbook(inlineWorkbook([softphone, ciscoAta, unprovisioned, yealink]));
    expect(devices.map((d) => d.macAddress)).toEqual(['80:5E:C0:AA:BB:CC']);
  });

  it('decodes XML entities in names', () => {
    const row: Cell[] = ['IGNORE', '1', 'Smith &amp; Jones &lt;Lobby&gt;', null, 'HardPhone', 'Yealink T48S', '805ec0000001', 'Online'];
    expect(parseMigrateWorkbook(inlineWorkbook([row]))[0]?.name).toBe('Smith & Jones <Lobby>');
  });

  it('throws when the header row is missing required columns', () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Nope</t></is></c></row></sheetData></worksheet>`;
    const bytes = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) });
    expect(() => parseMigrateWorkbook(bytes)).toThrow(/Serial\/MAC/);
  });
});

describe('buildSeedSql', () => {
  it('emits one upsert per device and escapes single quotes', () => {
    const sql = buildSeedSql(
      [
        { macAddress: '80:5E:C0:AA:BB:CC', rcDeviceId: '1', name: "O'Brien", extension: null, model: 'Yealink T48S', rcStatus: 'Online' },
        { macAddress: '64:16:7F:4B:6C:10', rcDeviceId: null, name: 'Lobby', extension: '100', model: null, rcStatus: null },
      ],
      '2026-09-17T00:00:00.000Z',
    );
    const statements = sql.trim().split(';\n').filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'O''Brien'");
    expect(statements[0]).toContain('ON CONFLICT(mac_address) DO UPDATE');
    expect(statements[0]).toContain("'2026-09-17T00:00:00.000Z'");
    expect(statements[1]).toContain("NULL, 'Lobby', '100', NULL, NULL");
  });
});
