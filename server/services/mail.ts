import nodemailer from 'nodemailer';
import { bulkInsert, pool, type Db } from '../db/pool.ts';

const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
const FROM = process.env.MAIL_FROM ?? 'Keel for Brightloop <billing@brightloop.example>';

export interface Mail {
  to: string;
  subject: string;
  body: string;
  kind: string;
  onDate: string;
}

/** Every message lands in the outbox. It also goes out by SMTP when that is configured. */
export async function sendMail(mail: Mail, db: Db = pool): Promise<void> {
  let status = 'logged';
  if (transport && !mail.to.endsWith('.demo') && !mail.to.endsWith('.example')) {
    try {
      await transport.sendMail({ from: FROM, to: mail.to, subject: mail.subject, text: mail.body });
      status = 'sent';
    } catch (err) {
      console.error('SMTP send failed', err);
      status = 'failed';
    }
  }
  await db.query(`INSERT INTO outbox (to_email, subject, body, kind, on_date, status) VALUES ($1,$2,$3,$4,$5,$6)`, [
    mail.to,
    mail.subject,
    mail.body,
    mail.kind,
    mail.onDate,
    status,
  ]);
}

export async function logMailBatch(mails: Mail[], db: Db = pool) {
  if (!mails.length) return;
  await bulkInsert(
    'outbox',
    mails.map((m) => ({ to_email: m.to, subject: m.subject, body: m.body, kind: m.kind, on_date: m.onDate, status: 'logged' })),
    db,
  );
}
