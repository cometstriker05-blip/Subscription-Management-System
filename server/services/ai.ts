// Gemini does the reading and the explaining. Money is only ever moved by deterministic
// code. Every feature here has a non-AI path, so a demo survives bad wifi.
import { GoogleGenAI, Type } from '@google/genai';
import { formatINR } from '../engine/index.ts';
import { appState } from './core.ts';
import { q } from '../db/pool.ts';
import { monthRange, overview, planBreakdown, revenueSummary, topOverdue } from './reports.ts';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';

function client(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    // Vertex AI keys start with AQ. and are refused by the Gemini API endpoint.
    return new GoogleGenAI(key.startsWith('AQ.') ? { vertexai: true, apiKey: key } : { apiKey: key });
  }
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && process.env.GOOGLE_CLOUD_PROJECT) {
    return new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION ?? 'global' });
  }
  return null;
}

export const aiStatus = () => ({ enabled: client() !== null, model: MODEL });

export async function aiParseStatement(content: Buffer, mimeType: string) {
  const ai = client();
  if (!ai) return null;
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: content.toString('base64'), mimeType } },
        { text: 'This is a bank statement. Extract every CREDIT transaction, meaning money received. Ignore debits, opening and closing balances, and page headers. Dates must be YYYY-MM-DD. Amounts in rupees as numbers. Keep the narration text exactly as printed.' },
      ],
    }],
    config: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ['credits'],
        properties: {
          credits: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ['date', 'narration', 'amount'],
              properties: { date: { type: Type.STRING }, narration: { type: Type.STRING }, amount: { type: Type.NUMBER } },
            },
          },
        },
      },
    },
  });
  const parsed = JSON.parse(response.text ?? '{"credits":[]}');
  return (parsed.credits as { date: string; narration: string; amount: number }[])
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date) && c.amount > 0)
    .map((c) => ({ date: c.date, description: c.narration, amount: Math.round(c.amount * 100) }));
}

export async function aiExplainBankLine(line: any): Promise<string | null> {
  const ai = client();
  if (!ai) return null;
  const candidates = line.candidates.map((c: any) => ({
    customer: c.customerName,
    why: c.reason,
    invoices: c.allocations.map((a: any) => `${a.invoiceNumber}: ${formatINR(a.amount)}`),
    ...(c.tdsAmount ? { taxDeductedAtSource: formatINR(c.tdsAmount) } : {}),
  }));
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: `A bank credit could not be matched with confidence. Narration: "${line.description}". Amount: ${formatINR(line.amount)}. Candidates: ${JSON.stringify(candidates)}. In at most two plain sentences, tell an accounts clerk which candidate is most likely and what to check before accepting it. Do not invent facts.`,
    // The limit covers the model's thinking too, so a tight one returns empty text.
    config: { temperature: 0.2, maxOutputTokens: 2048 },
  });
  return response.text?.trim() ?? null;
}

interface Receipt {
  label: string;
  value: string;
  href: string;
}

interface Tool {
  description: string;
  parameters?: Record<string, { type: Type; description: string }>;
  run: (args: any) => Promise<{ data: unknown; receipts: Receipt[] }>;
}

const money = (n: number) => formatINR(n);

/** The only things the model can reach: named, read-only questions. It never writes SQL. */
const TOOLS: Record<string, Tool> = {
  get_business_snapshot: {
    description: 'Active subscriptions, MRR, ARR, overdue totals and renewals right now.',
    run: async () => {
      const { today } = await appState();
      const o = await overview(today);
      return {
        data: { today, activeSubscriptions: o.active, mrr: money(o.mrr), arr: money(o.arr), overdue: money(o.overdue!.amount), overdueInvoices: o.overdue!.invoices, renewalsNext30Days: o.renewals!.soon, dueForBilling: o.dueNow },
        receipts: [
          { label: 'Active subscriptions', value: o.active.toLocaleString('en-IN'), href: '/subscriptions?status=active' },
          { label: 'MRR', value: money(o.mrr), href: '/revenue' },
          { label: 'Overdue', value: money(o.overdue!.amount), href: '/collections' },
        ],
      };
    },
  },
  get_revenue_for_period: {
    description: 'Invoiced, collected, outstanding, tax and the MRR bridge between two dates.',
    parameters: {
      from: { type: Type.STRING, description: 'Start date YYYY-MM-DD. Defaults to this month' },
      to: { type: Type.STRING, description: 'End date YYYY-MM-DD' },
      segment: { type: Type.STRING, description: 'small, mid or enterprise' },
    },
    run: async (args) => {
      const { today } = await appState();
      const range = monthRange(today);
      const s = await revenueSummary({ from: args.from ?? range.from, to: args.to ?? range.to, segment: args.segment }, today);
      return {
        data: {
          period: s.period, invoiced: money(s.invoiced), revenueBeforeTax: money(s.revenue), collected: money(s.collected), outstanding: money(s.outstanding),
          overdue: money(s.overdue), collectionRate: `${(s.collectionRate * 100).toFixed(1)}%`,
          mrrBridge: s.bridge.moves.map((m) => ({ kind: m.kind, amount: money(m.amount) })), netNewMrr: money(s.bridge.net),
        },
        receipts: [
          { label: 'Invoiced', value: money(s.invoiced), href: `/invoices?from=${s.period.from}&to=${s.period.to}` },
          { label: 'Collected', value: money(s.collected), href: `/payments?from=${s.period.from}&to=${s.period.to}` },
          { label: 'Net new MRR', value: money(s.bridge.net), href: '/revenue' },
        ],
      };
    },
  },
  list_overdue_customers: {
    description: 'Customers who owe the most overdue money, largest first.',
    parameters: { segment: { type: Type.STRING, description: 'small, mid or enterprise' } },
    run: async (args) => {
      const { today } = await appState();
      const rows = await topOverdue({ segment: args.segment }, today, 8);
      return {
        data: rows.map((r) => ({ customer: r.name, overdue: money(r.overdue), invoices: r.invoices, oldestDaysOverdue: r.oldest_days })),
        receipts: rows.slice(0, 4).map((r) => ({ label: r.name, value: money(r.overdue), href: `/customers/${r.id}` })),
      };
    },
  },
  list_plans_by_revenue: {
    description: 'Each plan with its active subscriptions and MRR.',
    run: async () => {
      const { today } = await appState();
      const rows = await planBreakdown({ ...monthRange(today) });
      return {
        data: rows.map((r) => ({ plan: r.name, subscriptions: r.subscriptions, mrr: money(r.mrr) })),
        receipts: rows.slice(0, 3).map((r) => ({ label: r.name, value: money(r.mrr), href: `/subscriptions?planId=${r.id}` })),
      };
    },
  },
  list_upcoming_renewals: {
    description: 'Contracts reaching expiry soon, with the value at stake and whether they renew themselves.',
    parameters: { days: { type: Type.NUMBER, description: 'Look ahead this many days. Default 30' } },
    run: async (args) => {
      const { today } = await appState();
      const days = Math.min(Number(args.days) || 30, 365);
      const rows = await q(
        `SELECT s.id, s.number, c.name, s.expiry_date, s.mrr, s.auto_renew, p.name AS plan
           FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id
          WHERE s.status = 'active' AND s.expiry_date <= $1::date + $2::int ORDER BY s.mrr DESC LIMIT 10`,
        [today, days],
      );
      const count = await q(`SELECT count(*)::int AS n, COALESCE(sum(mrr),0)::bigint AS mrr FROM subscriptions WHERE status = 'active' AND expiry_date <= $1::date + $2::int`, [today, days]);
      return {
        data: { contracts: count[0].n, mrrAtStake: money(count[0].mrr), largest: rows.map((r) => ({ number: r.number, customer: r.name, expires: r.expiry_date, mrr: money(r.mrr), renewsByItself: r.auto_renew })) },
        receipts: [{ label: `Renewals, ${days} days`, value: `${count[0].n} contracts`, href: '/renewals' }],
      };
    },
  },
};

export interface Answer {
  answer: string;
  receipts: Receipt[];
  mode: 'gemini' | 'rules';
  tools: string[];
}

export async function askKeel(question: string): Promise<Answer> {
  const ai = client();
  if (!ai) return askByRules(question);
  try {
    return await askGemini(ai, question);
  } catch (err) {
    console.error('Gemini failed, using rules', err);
    return askByRules(question);
  }
}

async function askGemini(ai: GoogleGenAI, question: string): Promise<Answer> {
  const { today, company } = await appState();
  const declarations = Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    parameters: { type: Type.OBJECT, properties: t.parameters ?? {} },
  }));
  const contents: any[] = [{ role: 'user', parts: [{ text: question }] }];
  const receipts: Receipt[] = [];
  const used: string[] = [];

  for (let turn = 0; turn < 4; turn++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        temperature: 0.1,
        systemInstruction: `You are Keel, the finance assistant for ${company.name}. Today is ${today}. Answer from tool results only and never estimate a figure. If the tools cannot answer, say so. Keep it to three short sentences, lead with the number, and write amounts exactly as the tools give them.`,
        tools: [{ functionDeclarations: declarations }],
      },
    });
    const calls = response.functionCalls ?? [];
    if (!calls.length) return { answer: response.text?.trim() ?? 'I could not answer that.', receipts, mode: 'gemini', tools: used };

    contents.push(response.candidates![0].content);
    const parts: any[] = [];
    for (const call of calls) {
      const tool = TOOLS[call.name!];
      const result = tool ? await tool.run(call.args ?? {}) : { data: { error: 'unknown tool' }, receipts: [] };
      used.push(call.name!);
      receipts.push(...result.receipts);
      parts.push({ functionResponse: { name: call.name, response: { result: result.data } } });
    }
    contents.push({ role: 'user', parts });
  }
  return { answer: 'That took too many steps. Try a narrower question.', receipts, mode: 'gemini', tools: used };
}

/** The offline path. Same tools and receipts, picked by keyword. */
async function askByRules(question: string): Promise<Answer> {
  const text = question.toLowerCase();
  const route = /(overdue|owe|chase|late|collect from)/.test(text) ? 'list_overdue_customers'
    : /(renew|expir)/.test(text) ? 'list_upcoming_renewals'
    : /(plan|product|which .* sell)/.test(text) ? 'list_plans_by_revenue'
    : /(revenue|invoiced|collected|month|quarter|bridge|churn)/.test(text) ? 'get_revenue_for_period'
    : 'get_business_snapshot';
  const result = await TOOLS[route].run({});
  const d = result.data as any;
  const answer =
    route === 'list_overdue_customers' ? `${d[0]?.customer ?? 'Nobody'} owes the most at ${d[0]?.overdue ?? '₹0'}, oldest ${d[0]?.oldestDaysOverdue ?? 0} days overdue. The top ${d.length} customers are listed below.`
    : route === 'list_upcoming_renewals' ? `${d.contracts} contracts worth ${d.mrrAtStake} of MRR reach expiry in the next 30 days.`
    : route === 'list_plans_by_revenue' ? `${d[0]?.plan} leads with ${d[0]?.mrr} of MRR across ${d[0]?.subscriptions} active subscriptions.`
    : route === 'get_revenue_for_period' ? `${d.invoiced} invoiced and ${d.collected} collected this month, with ${d.outstanding} still outstanding, of which ${d.overdue} is overdue.`
    : `${d.activeSubscriptions.toLocaleString('en-IN')} active subscriptions, ${d.mrr} of MRR, and ${d.overdue} overdue across ${d.overdueInvoices} invoices.`;
  return { answer, receipts: result.receipts, mode: 'rules', tools: [route] };
}

/** A month-end note for the finance lead, grounded in figures Keel computed. */
export async function monthBrief(opts: { useAi: boolean }) {
  const { today } = await appState();
  const range = monthRange(today);
  const s = await revenueSummary(range, today);
  const overdue = await topOverdue({}, today, 3);
  const facts = {
    period: range, activeSubscriptions: s.activeSubscriptions, mrr: money(s.mrr), arr: money(s.arr), invoiced: money(s.invoiced),
    collected: money(s.collected), collectionRate: `${(s.collectionRate * 100).toFixed(1)}%`, outstanding: money(s.outstanding),
    overdue: money(s.overdue), overdueInvoices: s.overdueCount, netNewMrr: money(s.bridge.net),
    movements: s.bridge.moves.map((m) => `${m.kind} ${money(m.amount)}`),
    topOverdue: overdue.map((o) => `${o.name} ${money(o.overdue)}`),
  };
  const ai = opts.useAi ? client() : null;
  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: `Write a month-end note for a finance lead from these facts only: ${JSON.stringify(facts)}. Four short sentences. First what happened to recurring revenue, then cash, then the single biggest risk, then one recommended action. Use the amounts exactly as given.`,
        config: { temperature: 0.2, maxOutputTokens: 8192 },
      });
      if (response.text) return { text: response.text.trim(), mode: 'gemini' as const, facts };
    } catch (err) {
      console.error('Gemini brief failed, using template', err);
    }
  }
  const text = `MRR stands at ${facts.mrr} after ${facts.netNewMrr} of net movement this month. ${facts.collected} has come in against ${facts.invoiced} invoiced, with ${facts.outstanding} still outstanding. ${facts.overdue} across ${facts.overdueInvoices} invoices is overdue${facts.topOverdue[0] ? `, led by ${facts.topOverdue[0]}` : ''}. Start collections with the largest balance first.`;
  return { text, mode: 'rules' as const, facts };
}
