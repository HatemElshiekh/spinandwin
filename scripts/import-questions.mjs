// Reads the question bank Excel file and writes a SQL file that imports it.
//
//   npm run questions -- path/to/adipec-2026-question-bank-template.xlsx [out.sql]
//
// The whole file is rejected if any active row is invalid. The generated SQL calls
// spin.import_questions(), which validates every row again inside the database.
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';

const HEADERS = ['question_id', 'wall', 'question', 'option_a', 'option_b', 'option_c', 'option_d',
  'correct_option', 'hint', 'active', 'notes', 'check'];
const FORBIDDEN = [/\bexclusive\b/i, /\bnew\b/i, /for the first time/i, /guarantee/i, /\u2014/];

const [input, output = 'supabase/questions-import.sql'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: npm run questions -- <file.xlsx> [out.sql]');
  process.exit(1);
}

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('result' in v) return text(v.result);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
  }
  return String(v).trim();
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(input);
const ws = wb.getWorksheet('Questions');
if (!ws) {
  console.error('No "Questions" tab found.');
  process.exit(1);
}

const header = HEADERS.map((_, i) => text(ws.getRow(1).getCell(i + 1).value).toLowerCase());
if (header.join('|') !== HEADERS.join('|')) {
  console.error('Unexpected headers in the Questions tab:\n  found:    ' + header.join(', ') +
    '\n  expected: ' + HEADERS.join(', '));
  process.exit(1);
}

const rows = [];
const errors = [];
const warnings = [];
ws.eachRow((row, n) => {
  if (n === 1) return;
  const cell = (i) => text(row.getCell(i + 1).value);
  const id = cell(0);
  if (!id && !cell(2)) return;
  const r = {
    id, wall: cell(1), question: cell(2), a: cell(3), b: cell(4), c: cell(5), d: cell(6),
    correct: cell(7).toUpperCase(), hint: cell(8), active: cell(9).toLowerCase() === 'yes', check: cell(11),
  };
  rows.push(r);
  if (!r.active) return;
  const where = `row ${n} (${id || 'no id'})`;
  if (!/^Q\d{2,3}$/.test(id)) errors.push(`${where}: question_id must look like Q01`);
  for (const k of ['wall', 'question', 'a', 'b', 'c', 'd', 'hint']) {
    if (!r[k]) errors.push(`${where}: ${k} is empty`);
  }
  if (!['A', 'B', 'C', 'D'].includes(r.correct)) errors.push(`${where}: correct_option must be A, B, C or D`);
  if (r.check !== 'OK') errors.push(`${where}: check column says "${r.check || 'empty'}"`);
  if (new Set([r.a, r.b, r.c, r.d].map((o) => o.toLowerCase())).size !== 4) errors.push(`${where}: duplicate options`);
  for (const k of ['question', 'a', 'b', 'c', 'd', 'hint']) {
    for (const f of FORBIDDEN) if (f.test(r[k])) warnings.push(`${where}: ${k} contains "${r[k].match(f)[0]}"`);
  }
});

const ids = rows.map((r) => r.id);
for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) errors.push(`${id} appears more than once`);

if (errors.length) {
  console.error('Import rejected. Fix these rows and try again:\n  ' + errors.join('\n  '));
  process.exit(1);
}
if (warnings.length) console.warn('Check these before the show (permit wording):\n  ' + warnings.join('\n  '));

const json = JSON.stringify(rows).replace(/'/g, "''");
writeFileSync(output, `-- Generated from ${input.split('/').pop()} on ${new Date().toISOString()}\n` +
  `select spin.import_questions('${json}'::jsonb);\n`);
console.log(`${rows.filter((r) => r.active).length} active questions of ${rows.length} rows. SQL written to ${output}`);
