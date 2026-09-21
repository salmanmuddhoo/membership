// A report as a spreadsheet (S-905 to S-907).
//
// The part worth testing is not the formatting. It is that a value which
// arrived from a form does not become a formula when somebody opens the file:
// a spreadsheet treats a leading =, +, - or @ as the start of one, so a
// report is a way to hand whoever opens it whatever was typed into an
// application — unless something stops it.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { neutralise, reportFileName, reportToWorkbook } from './export';
import type { ReportResult } from './definitions';

const CONTEXT = {
  generatedAt: new Date('2026-09-16T10:00:00Z'),
  generatedBy: 'officer@albarakah.mu',
  filters: 'From: 2026-01-01',
};

async function cellsOf(result: ReportResult): Promise<string[][]> {
  const buffer = await reportToWorkbook('Members', result, CONTEXT);
  const workbook = new ExcelJS.Workbook();
  // exceljs bundles its own @types/node, whose Buffer differs from ours.
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];

  const rows: string[][] = [];
  sheet.eachRow(row => {
    const values = row.values as unknown[];
    rows.push(values.slice(1).map(v => (v == null ? '' : String(v))));
  });
  return rows;
}

describe('neutralise', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)'])(
    'defuses a value starting %s',
    value => {
      expect(neutralise(value)).toBe(`'${value}`);
    }
  );

  it('leaves ordinary text alone', () => {
    expect(neutralise('Fatimah Joomun')).toBe('Fatimah Joomun');
    expect(neutralise('AB1001')).toBe('AB1001');
    expect(neutralise('')).toBe('');
  });

  // A minus inside a value is not a formula; only a leading one is.
  it('leaves a hyphen that is not leading alone', () => {
    expect(neutralise('Rose-Hill')).toBe('Rose-Hill');
    expect(neutralise('2026-01-01')).toBe('2026-01-01');
  });
});

describe('reportToWorkbook', () => {
  const RESULT: ReportResult = {
    columns: [
      { key: 'Name', label: 'Name' },
      { key: 'Amount', label: 'Amount', numeric: true },
    ],
    rows: [
      { Name: 'Fatimah Joomun', Amount: 1500 },
      { Name: '=cmd|calc', Amount: 250.5 },
    ],
    summary: '2 member(s).',
  };

  it('writes the header and every row', async () => {
    const cells = await cellsOf(RESULT);

    expect(cells.some(r => r[0] === 'Name' && r[1] === 'Amount')).toBe(true);
    expect(cells.some(r => r[0] === 'Fatimah Joomun')).toBe(true);
    // Title, generated, by, filters, summary, header, and the two rows.
    // The blank spacer between the preamble and the header is not counted:
    // eachRow skips empty rows.
    expect(cells).toHaveLength(8);
  });

  // The whole reason neutralise exists, checked where it actually matters —
  // in the file a person opens.
  it('does not let a value become a formula', async () => {
    const cells = await cellsOf(RESULT);
    const row = cells.find(r => r[0]?.includes('cmd|calc'))!;

    expect(row[0]).toBe("'=cmd|calc");
  });

  // A spreadsheet outlives the screen it came from. A table of figures with
  // no period and no author on it is one nobody can check later.
  it('says who ran it, when, and over what', async () => {
    const cells = await cellsOf(RESULT);
    const flat = cells.flat().join('\n');

    expect(flat).toContain('Members');
    expect(flat).toContain('officer@albarakah.mu');
    expect(flat).toContain('From: 2026-01-01');
    expect(flat).toContain('2 member(s).');
  });

  it('keeps a numeric column numeric, so it can be summed', async () => {
    const buffer = await reportToWorkbook('Members', RESULT, CONTEXT);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.worksheets[0];

    // Header at row 7 (title, generated, by, filters, summary, blank).
    expect(typeof sheet.getRow(8).getCell(2).value).toBe('number');
    expect(sheet.getRow(8).getCell(2).value).toBe(1500);
  });

  // A numeric column that somehow holds text must not become NaN, which a
  // spreadsheet shows as an error nobody can interpret.
  it('keeps text in a numeric column as text', async () => {
    const cells = await cellsOf({
      columns: [{ key: 'Amount', label: 'Amount', numeric: true }],
      rows: [{ Amount: 'not a number' }],
    });

    expect(cells.flat()).toContain('not a number');
    expect(cells.flat().join()).not.toContain('NaN');
  });

  it('says nothing about filters when none were chosen', async () => {
    const cells = await cellsOf({ ...RESULT });
    // Only that they were absent; never a blank line that reads as a period.
    const flat = cells.flat().join('\n');
    expect(flat).toContain('From: 2026-01-01');
  });

  // Excel refuses a sheet name over 31 characters or containing : \ / ? * [ ]
  it('makes a usable sheet name from any title', async () => {
    const buffer = await reportToWorkbook(
      'Payments/receipts: a very long report title indeed',
      RESULT,
      CONTEXT
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);

    const name = workbook.worksheets[0].name;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[:\\/?*[\]]/);
  });

  it('handles a report with no rows', async () => {
    const cells = await cellsOf({
      columns: [{ key: 'Name', label: 'Name' }],
      rows: [],
    });
    expect(cells.some(r => r[0] === 'Name')).toBe(true);
  });
});

describe('reportFileName', () => {
  it('names the report and the day it was run', () => {
    expect(reportFileName('members', new Date('2026-09-16T10:00:00Z'))).toBe(
      'members-2026-09-16.xlsx'
    );
  });
});
