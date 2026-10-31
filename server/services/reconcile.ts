// Replaces "scrolling through bank statements". Layers: parse the file, match each
// credit with deterministic rules, auto-post only what clears the bar, and queue the
// rest with reasons. A confirmed guess teaches Keel the payer's name for next time.
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { bulkInsert, one, q, tx } from '../db/pool.ts';
import { AUTO_POST_THRESHOLD, formatINR, matchBankLine, normalize, type MatchCandidate, type OpenInvoice } from '../engine/index.ts';
import { aiExplainBankLine, aiParseStatement } from './ai.ts';
import { appState, audit, conflict, invalid, notFound, type Actor } from './core.ts';

export interface ParsedLine {
  date: string;
  description: string;
  amount: number;
}

export async function loadOpenInvoices(db: PoolClient | undefined = undefined): Promise<OpenInvoice[]> {
  const rows = await q(
    `SELECT i.id, i.number, i.customer_id, c.name AS customer_name, i.total - i.amount_paid AS outstanding, i.taxable, i.due_date
       FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'confirmed' AND i.number IS NOT NULL`,
    [],
    db,
  );
  return rows.map((r) => ({ id: r.id, number: r.number, customerId: r.customer_id, customerName: r.customer_name, outstanding: r.outstanding, taxable: r.taxable, dueDate: r.due_date }));
}

const parseAmount = (raw: string) => {
  const value = Number(String(raw).replace(/[₹,\s]|Rs\.?|INR/gi, ''));
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};

function parseDate(raw: string): string | null {
  const text = raw.trim();
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const months = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
  m = text.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-](\d{2,4})$/);
  if (m) {
    const month = months.indexOf(m[2].toLowerCase()) + 1;
    if (month) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (quoted && row[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** Reads the CSV layouts Indian banks export, whatever order the columns are in. */
export function parseCsvStatement(text: string): ParsedLine[] {
  const rows = text.split(/\r?\n/).filter((r) => r.trim());
  const headerAt = rows.findIndex((r) => /date/i.test(r) && /(narration|description|particulars|remarks|details)/i.test(r));
  if (headerAt < 0) return [];
  const headers = splitCsvRow(rows[headerAt]).map((h) => h.toLowerCase());
  const find = (...names: RegExp[]) => headers.findIndex((h) => names.some((n) => n.test(h)));
  const dateCol = find(/date/);
  const descCol = find(/narration/, /description/, /particulars/, /remarks/, /details/);
  const creditCol = find(/credit/, /deposit/, /^cr\b/);
  const amountCol = find(/^amount/);

  const out: ParsedLine[] = [];
  for (const row of rows.slice(headerAt + 1)) {
    const cells = splitCsvRow(row);
    const date = parseDate(cells[dateCol] ?? '');
    const amount = parseAmount(cells[creditCol >= 0 ? creditCol : amountCol] ?? '');
    if (date && amount > 0) out.push({ date, description: cells[descCol] ?? '', amount });
  }
  return out;
}

export async function ingestStatement(params: { filename: string; mimeType: string; content: Buffer; actor: Actor }) {
  const { filename, mimeType, content, actor } = params;
  const isText = /csv|text/.test(mimeType) || /\.(csv|txt)$/i.test(filename);
  let source = 'csv';
  let lines = isText ? parseCsvStatement(content.toString('utf8')) : [];

  if (!lines.length) {
    const read = await aiParseStatement(content, isText ? 'text/plain' : mimeType);
    if (!read) throw invalid(isText ? 'No credit lines found. The file needs a date, a narration and a credit column' : 'Reading PDFs and photos needs Gemini. Add GEMINI_API_KEY, or upload the CSV export');
    lines = read;
    source = 'gemini';
  }
  if (!lines.length) throw invalid('No credits found in this statement');

  const [openInvoices, aliases] = await Promise.all([loadOpenInvoices(), q(`SELECT alias, customer_id FROM payer_aliases`)]);
  const aliasList = aliases.map((a) => ({ alias: a.alias, customerId: a.customer_id }));

  return tx(async (client) => {
    const statement = await one(
      `INSERT INTO bank_statements (filename, source, uploaded_by, line_count) VALUES ($1,$2,$3,$4) RETURNING id`,
      [filename, source, actor.name, lines.length],
      client,
    );
    const tally = { auto_posted: 0, suggested: 0, unmatched: 0, duplicates: 0, posted: 0 };
    const remaining = new Map(openInvoices.map((i) => [i.id, i]));

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const fingerprint = createHash('sha256').update(`${line.date}|${normalize(line.description)}|${line.amount}|${index}`).digest('hex').slice(0, 24);
      const exists = await one(`SELECT 1 AS ok FROM bank_lines WHERE fingerprint = $1`, [fingerprint], client);
      if (exists) {
        tally.duplicates++;
        continue;
      }
      const candidates = matchBankLine({ id: 0, date: line.date, description: line.description, amount: line.amount }, [...remaining.values()], aliasList);
      const best = candidates[0];
      const status = !best ? 'unmatched' : best.confidence >= AUTO_POST_THRESHOLD ? 'auto_posted' : 'suggested';
      const row = await one(
        `INSERT INTO bank_lines (statement_id, txn_date, description, amount, fingerprint, status, candidates, confidence, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [statement!.id, line.date, line.description, line.amount, fingerprint, status, JSON.stringify(candidates.slice(0, 3)), best?.confidence ?? null, best?.reason ?? 'Nothing open fits this credit'],
        client,
      );
      tally[status]++;
      if (status === 'auto_posted') {
        const paymentId = await postMatch(client, row!.id, line, best, actor.name, 'bank');
        await client.query(`UPDATE bank_lines SET payment_id = $2 WHERE id = $1`, [row!.id, paymentId]);
        tally.posted += line.amount;
        for (const a of best.allocations) {
          const inv = remaining.get(a.invoiceId);
          if (inv) {
            const left = inv.outstanding - a.amount - best.tdsAmount;
            if (left <= 0) remaining.delete(a.invoiceId);
            else remaining.set(a.invoiceId, { ...inv, outstanding: left });
          }
        }
      }
    }
    await audit(actor.name, 'reconcile.ingest', 'bank_statement', statement!.id, { filename, ...tally });
    return { statementId: statement!.id as number, lines: lines.length, ...tally };
  });
}

async function postMatch(client: PoolClient, bankLineId: number, line: ParsedLine, match: MatchCandidate, actor: string, source: string) {
  const seq = await one(`SELECT nextval('payment_number_seq') AS n`, [], client);
  const number = `PAY-${String(seq!.n).padStart(6, '0')}`;
  const payment = await one(
    `INSERT INTO payments (number, customer_id, method, amount, paid_on, note, reference, source, bank_line_id, created_by)
     VALUES ($1,$2,'bank_transfer',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [number, match.customerId, line.amount, line.date, match.reason, line.description.slice(0, 80), source, bankLineId, actor],
    client,
  );
  for (const a of match.allocations) {
    await client.query(`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`, [payment!.id, a.invoiceId, a.amount]);
  }
  if (match.tdsAmount > 0) {
    const tdsSeq = await one(`SELECT nextval('payment_number_seq') AS n`, [], client);
    const tds = await one(
      `INSERT INTO payments (number, customer_id, method, amount, paid_on, note, reference, source, created_by)
       VALUES ($1,$2,'tds',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [`PAY-${String(tdsSeq!.n).padStart(6, '0')}`, match.customerId, match.tdsAmount, line.date, 'Tax deducted at source by the customer', 'TDS', source, actor],
      client,
    );
    await client.query(`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`, [tds!.id, match.allocations[0].invoiceId, match.tdsAmount]);
  }
  return payment!.id as number;
}

/** A person accepts a suggestion. Keel learns the payer's name from it. */
export async function confirmLine(id: number, candidateIndex: number, actor: Actor) {
  return tx(async (client) => {
    const line = await one(`SELECT * FROM bank_lines WHERE id = $1 FOR UPDATE`, [id], client);
    if (!line) throw notFound('Bank line');
    if (['auto_posted', 'confirmed'].includes(line.status)) throw conflict('This line has already been posted');
    const candidate: MatchCandidate | undefined = line.candidates[candidateIndex];
    if (!candidate) throw invalid('That suggestion no longer exists');
    const paymentId = await postMatch(client, id, { date: line.txn_date, description: line.description, amount: line.amount }, candidate, actor.name, 'bank');
    await client.query(`UPDATE bank_lines SET status = 'confirmed', payment_id = $2 WHERE id = $1`, [id, paymentId]);

    const alias = payerName(line.description);
    if (alias) {
      await client.query(
        `INSERT INTO payer_aliases (alias, customer_id, learned_from) VALUES ($1,$2,$3) ON CONFLICT (alias) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
        [alias, candidate.customerId, actor.name],
      );
    }
    await audit(actor.name, 'reconcile.confirm', 'bank_line', id, { customer: candidate.customerName, amount: line.amount, learned: alias });
    return { paymentId, learned: alias };
  });
}

export async function assignLine(id: number, invoiceId: number, actor: Actor) {
  return tx(async (client) => {
    const line = await one(`SELECT * FROM bank_lines WHERE id = $1 FOR UPDATE`, [id], client);
    if (!line) throw notFound('Bank line');
    if (['auto_posted', 'confirmed'].includes(line.status)) throw conflict('This line has already been posted');
    const inv = await one(`SELECT i.id, i.number, i.customer_id, i.total - i.amount_paid AS owed, c.name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1 AND i.status = 'confirmed'`, [invoiceId], client);
    if (!inv) throw notFound('Open invoice');
    if (line.amount > inv.owed) throw conflict(`This credit of ${formatINR(line.amount)} is more than the ${formatINR(inv.owed)} owed on ${inv.number}`);
    const candidate: MatchCandidate = {
      kind: 'amount_only', customerId: inv.customer_id, customerName: inv.name, confidence: 1, tdsAmount: 0, reason: `Matched by hand by ${actor.name}`,
      allocations: [{ invoiceId: inv.id, invoiceNumber: inv.number, amount: line.amount }],
    };
    const paymentId = await postMatch(client, id, { date: line.txn_date, description: line.description, amount: line.amount }, candidate, actor.name, 'bank');
    await client.query(`UPDATE bank_lines SET status = 'confirmed', payment_id = $2, reason = $3 WHERE id = $1`, [id, paymentId, candidate.reason]);
    const alias = payerName(line.description);
    if (alias) await client.query(`INSERT INTO payer_aliases (alias, customer_id, learned_from) VALUES ($1,$2,$3) ON CONFLICT (alias) DO UPDATE SET customer_id = EXCLUDED.customer_id`, [alias, inv.customer_id, actor.name]);
    return { paymentId, learned: alias };
  });
}

export async function ignoreLine(id: number, actor: Actor) {
  await tx(async (client) => {
    const hit = await client.query(`UPDATE bank_lines SET status = 'ignored' WHERE id = $1 AND status IN ('suggested','unmatched')`, [id]);
    if (!hit.rowCount) throw conflict('This line cannot be ignored');
    await audit(actor.name, 'reconcile.ignore', 'bank_line', id, {}, client);
  });
}

export async function explainLine(id: number) {
  const line = await one(`SELECT * FROM bank_lines WHERE id = $1`, [id]);
  if (!line) throw notFound('Bank line');
  const note = await aiExplainBankLine(line);
  if (note) await q(`UPDATE bank_lines SET ai_note = $2 WHERE id = $1`, [id, note]);
  return { note };
}

/** The narration with bank noise removed. What remains is usually the payer's name. */
export function payerName(narration: string): string | null {
  const text = normalize(narration)
    .replace(/\b(neft|imps|rtgs|upi|cr|dr|inb|ach|chq|trf|transfer|payment|ref|by|from|to|bl|inv|invoice)\b/g, ' ')
    .replace(/\b[a-z]*\d+[a-z0-9]*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 4 ? text.slice(0, 60) : null;
}

/** Builds a realistic statement from whatever is genuinely open, so the demo always works. */
export async function sampleStatement() {
  const { today } = await appState();
  const rows = await q(
    `WITH open AS (
       SELECT i.id, i.number, i.customer_id, c.name, i.total - i.amount_paid AS owed, i.taxable, i.due_date,
              row_number() OVER (PARTITION BY i.customer_id ORDER BY i.due_date) AS rn,
              count(*) OVER (PARTITION BY i.customer_id) AS n
         FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.status = 'confirmed' AND i.amount_paid = 0 AND i.number IS NOT NULL)
     SELECT * FROM open WHERE rn <= 3 ORDER BY owed DESC LIMIT 2500`,
  );
  const singles = rows.filter((r) => r.n === 1);
  const multi = rows.filter((r) => r.n >= 2);
  // Walk through the list in big steps, so the statement has a realistic spread of amounts.
  let cursor = 0;
  const take = (pool: any[]) => {
    cursor += 137;
    return pool.length ? pool.splice(cursor % pool.length, 1)[0] : undefined;
  };
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.owed, (counts.get(r.owed) ?? 0) + 1);
  const unique = singles.filter((r) => counts.get(r.owed) === 1);

  const fmt = (paise: number) => (paise / 100).toFixed(2);
  const out: [string, string, string][] = [];
  const add = (desc: string, amount: number) => out.push([today, desc, fmt(amount)]);

  for (let i = 0; i < 9; i++) {
    const r = take(singles);
    if (r) add(`NEFT CR ${r.number} ${shortName(r.name)}`, r.owed);
  }
  for (let i = 0; i < 3; i++) {
    const r = take(singles);
    if (r) add(`RTGS INV ${r.number.replace(/\//g, ' ')} ${shortName(r.name)}`, r.owed);
  }
  for (let i = 0; i < 3; i++) {
    const r = take(singles);
    if (r) add(`NEFT ${r.number} TDS DEDUCTED`, r.owed - Math.round(r.taxable * 0.1));
  }
  for (let i = 0; i < 2; i++) {
    const r = take(singles);
    if (r) add(`IMPS ${shortName(r.name).toUpperCase()} SUBSCRIPTION`, r.owed);
  }
  const customerIds = [...new Set(multi.map((m) => m.customer_id))].slice(4, 6);
  for (const id of customerIds) {
    const pair = multi.filter((m) => m.customer_id === id).slice(0, 2);
    if (pair.length === 2) add(`NEFT ${shortName(pair[0].name).toUpperCase()} OCT DUES`, pair[0].owed + pair[1].owed);
  }
  const part = take(singles);
  if (part) add(`NEFT ${part.number} PART PAYMENT`, Math.round(part.owed * 0.4));
  const noName = take(unique);
  if (noName) add(`CASH DEPOSIT BRANCH 0821`, noName.owed);
  const alias = take(unique);
  if (alias) add(`UPI ${initials(alias.name)} GLOBAL HOLDINGS 88210`, alias.owed + 1100);
  add('INTEREST CREDIT Q3', 842150);
  add('NEFT UNKNOWN VENDOR REFUND', 1234500);

  const csv = ['Txn Date,Narration,Credit', ...out.map(([d, n, a]) => `${d},"${n}",${a}`)].join('\n');
  return { filename: `brightloop-hdfc-${today}.csv`, csv };
}

const shortName = (name: string) => name.split(' ').slice(0, 2).join(' ');
const initials = (name: string) => name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export async function loadStatement(id: number) {
  const [statement, lines] = await Promise.all([
    one(`SELECT * FROM bank_statements WHERE id = $1`, [id]),
    q(`SELECT l.*, p.number AS payment_number FROM bank_lines l LEFT JOIN payments p ON p.id = l.payment_id WHERE l.statement_id = $1 ORDER BY l.id`, [id]),
  ]);
  if (!statement) throw notFound('Statement');
  return { statement, lines };
}

export const insertAliases = (rows: { alias: string; customer_id: number }[]) => bulkInsert('payer_aliases', rows);
