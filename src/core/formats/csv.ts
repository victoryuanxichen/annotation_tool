/**
 * RFC 4180 CSV writer/reader plus spreadsheet formula protection (SPEC §2.1).
 */

export const UTF8_BOM = '﻿';
export const CRLF = '\r\n';

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r', '\n', "'"]);

/** Prefixes `'` to text a spreadsheet could read as a formula. A leading `'` is itself escaped. */
export function protectFormula(text: string): string {
  return text.length > 0 && FORMULA_TRIGGERS.has(text[0]) ? `'${text}` : text;
}

/** Inverse of `protectFormula`: strips exactly one leading `'`. */
export function unprotectFormula(text: string): string {
  return text.startsWith("'") ? text.slice(1) : text;
}

export function quoteCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface CsvWriteOptions {
  /** Prepend a UTF-8 BOM (default true). */
  bom?: boolean;
  /** Line terminator (default CRLF). Every row, including the last, is terminated. */
  eol?: string;
}

export function writeCsv(rows: readonly (readonly string[])[], options: CsvWriteOptions = {}): string {
  const eol = options.eol ?? CRLF;
  const body = rows.map((r) => r.map(quoteCsvField).join(',') + eol).join('');
  return (options.bom ?? true ? UTF8_BOM : '') + body;
}

export interface CsvRow {
  cells: string[];
  /** 1-based line number where the row starts. */
  line: number;
}

export type CsvParseResult =
  | { ok: true; rows: CsvRow[] }
  | { ok: false; error: { code: 'csv_unterminated_quote'; line: number } };

/**
 * Parses CSV text (optional BOM; CRLF, LF or lone CR line endings; quoted fields containing
 * commas, quotes and line breaks). Blank lines are skipped. Characters after a closing quote
 * are kept literally, as spreadsheet applications do.
 */
export function parseCsv(text: string): CsvParseResult {
  const src = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let line = 1;
  let rowLine = 1;
  let i = 0;

  const endRow = (): void => {
    cells.push(field);
    if (!(cells.length === 1 && cells[0] === '')) rows.push({ cells, line: rowLine });
    cells = [];
    field = '';
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' && field === '' && atFieldStart(src, i)) {
      const quoteLine = line;
      i++;
      for (;;) {
        if (i >= src.length) return { ok: false, error: { code: 'csv_unterminated_quote', line: quoteLine } };
        const c = src[i];
        if (c === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (c === '\n' || (c === '\r' && src[i + 1] !== '\n')) line++;
        field += c;
        i++;
      }
      continue;
    }
    if (ch === ',') {
      cells.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line++;
      rowLine = line;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || cells.length > 0) endRow();
  return { ok: true, rows };
}

function atFieldStart(src: string, i: number): boolean {
  if (i === 0) return true;
  const prev = src[i - 1];
  return prev === ',' || prev === '\n' || prev === '\r';
}
