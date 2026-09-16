// A report as a spreadsheet (S-905 to S-907).
//
// Every report offers this because a report that cannot leave the screen is
// half a report: the Society's committee papers, its auditor and its
// regulator all want a file, and the alternative is somebody retyping a table
// — which is where the errors come from.
//
// The same ExcelJS the migration template already uses, so no new dependency.
import ExcelJS from 'exceljs';
import type { ReportColumn, ReportResult } from './definitions';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * A leading `=`, `+`, `-` or `@` makes a spreadsheet treat a cell as a
 * formula, so a value that arrived from a form can become one when the file
 * is opened — the injection this application would otherwise hand straight to
 * whoever opens the report.
 *
 * Prefixing with an apostrophe is the conventional defence: the cell reads as
 * the text it is, and the apostrophe is not part of the value.
 */
export function neutralise(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cellValue(
  raw: string | number | null,
  column: ReportColumn
): string | number | null {
  if (raw === null || raw === undefined) return null;
  if (column.numeric) {
    const asNumber = Number(raw);
    // A numeric column that is not a number stays text rather than becoming
    // NaN, which a spreadsheet shows as an error nobody can interpret.
    return Number.isFinite(asNumber) ? asNumber : neutralise(String(raw));
  }
  return typeof raw === 'number' ? raw : neutralise(String(raw));
}

export async function reportToWorkbook(
  title: string,
  result: ReportResult,
  context: { generatedAt: Date; generatedBy: string; filters: string }
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  // Sheet names may not exceed 31 characters, nor contain : \ / ? * [ ].
  const sheet = workbook.addWorksheet(
    title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31)
  );

  // Who ran it, when, and over what. A spreadsheet outlives the screen it came
  // from, and a table of figures with no period on it is a table nobody can
  // check later.
  sheet.addRow([title]).font = { bold: true, size: 14 };
  sheet.addRow([`Generated ${context.generatedAt.toISOString()}`]);
  sheet.addRow([`By ${context.generatedBy}`]);
  sheet.addRow([context.filters || 'No filters']);
  if (result.summary) sheet.addRow([result.summary]);
  sheet.addRow([]);

  const header = sheet.addRow(result.columns.map(c => c.label));
  header.font = { bold: true };

  for (const row of result.rows) {
    sheet.addRow(result.columns.map(c => cellValue(row[c.key] ?? null, c)));
  }

  for (const [index, column] of result.columns.entries()) {
    const width = Math.max(
      column.label.length + 2,
      ...result.rows.map(r => String(r[column.key] ?? '').length + 2)
    );
    sheet.getColumn(index + 1).width = Math.min(Math.max(width, 10), 50);
    if (column.numeric) {
      sheet.getColumn(index + 1).alignment = { horizontal: 'right' };
    }
  }

  // exceljs bundles its own @types/node, whose Buffer differs from ours.
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

// A file name somebody can find again in a downloads folder six months later.
export function reportFileName(code: string, at: Date): string {
  return `${code}-${at.toISOString().slice(0, 10)}.xlsx`;
}
