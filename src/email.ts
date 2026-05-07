import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import type { Reservation } from './db';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.FROM_EMAIL ?? 'onboarding@resend.dev';
const FROM_NAME = 'さとやまコーヒー 取り置きシステム';

async function sendMailViaResend(to: string[], subject: string, text: string): Promise<void> {
  if (!resend) throw new Error('RESEND_API_KEY 未設定');
  const { error } = await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to,
    subject,
    text,
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}

async function sendMailViaSmtp(to: string[], subject: string, text: string): Promise<void> {
  await createTransport().sendMail({
    from: `"${FROM_NAME}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
  });
}

async function sendMail(to: string[], subject: string, text: string): Promise<void> {
  if (resend) return sendMailViaResend(to, subject, text);
  return sendMailViaSmtp(to, subject, text);
}

function createTransport() {
  const port = Number(process.env.SMTP_PORT ?? 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port,
    secure: port === 465,  // 465 は SSL/TLS、587 は STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

export async function verifySmtp(): Promise<void> {
  if (resend) {
    console.log(`[mail] Resend モードで起動 (FROM=${FROM_EMAIL})`);
    return;
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mail] RESEND_API_KEY も SMTP も未設定。メール送信は無効です。');
    return;
  }
  try {
    await createTransport().verify();
    console.log(`[mail] SMTP接続OK (${process.env.SMTP_HOST}:${process.env.SMTP_PORT})`);
  } catch (e: any) {
    console.error('[mail] SMTP接続NG:', e?.message ?? e);
  }
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function itemsText(reservation: Reservation): string {
  return reservation.items.map(i => `  ・${i.product_name} × ${i.quantity}個`).join('\n');
}

function cancelUrl(reservation: Reservation): string {
  const base = process.env.APP_URL ?? 'http://localhost:3000';
  return `${base}/cancel/${reservation.cancel_token}`;
}

function splitEmails(s: string | undefined): string[] {
  return (s ?? '').split(',').map(x => x.trim()).filter(Boolean);
}

export async function sendConfirmationEmail(reservation: Reservation): Promise<void> {
  const pickupDate = formatDate(reservation.pickup_date);
  const totalItems = reservation.items.reduce((s, i) => s + i.quantity, 0);
  await sendMail([reservation.customer_email], '【取り置き受付完了】ご予約を承りました', [
    `${reservation.customer_name} 様`,
    '',
    '以下の内容で取り置きを承りました。',
    '',
    `受付番号: #${reservation.id}`,
    `受取拠点: ${reservation.store_name}`,
    `受け取り日: ${pickupDate}`,
    `合計: ${totalItems}点`,
    '',
    '【お取り置き内容】',
    itemsText(reservation),
    '',
    'ご来店の際は受付番号をお知らせください。',
    'お待ちしております！',
    '',
    '─────────────────────',
    'キャンセルはこちらから（受取日前日まで）:',
    cancelUrl(reservation),
    '─────────────────────',
    'さとやまコーヒー',
  ].join('\n'));
}

export async function sendStoreNotificationEmail(reservation: Reservation): Promise<void> {
  const recipients = splitEmails(process.env.STORE_EMAIL);
  if (recipients.length === 0) return;
  const pickupDate = formatDate(reservation.pickup_date);
  await sendMail(recipients, `【新規取り置き】${reservation.store_name} ${pickupDate} ${reservation.items.length}種`, [
    '新しい取り置きが入りました。',
    '',
    `受付番号: #${reservation.id}`,
    `拠点: ${reservation.store_name}`,
    `お客様名: ${reservation.customer_name}`,
    `メール: ${reservation.customer_email}`,
    `受け取り日: ${pickupDate}`,
    `受付日時: ${reservation.created_at}`,
    '',
    '【取り置き内容】',
    itemsText(reservation),
  ].join('\n'));
}

export async function sendCancelEmail(reservation: Reservation): Promise<void> {
  const pickupDate = formatDate(reservation.pickup_date);
  await sendMail([reservation.customer_email], `【キャンセル完了】受付番号 #${reservation.id}`, [
    `${reservation.customer_name} 様`,
    '',
    '以下の取り置きをキャンセルしました。',
    '',
    `受付番号: #${reservation.id}`,
    `受取拠点: ${reservation.store_name}`,
    `受け取り日: ${pickupDate}`,
    '',
    '【キャンセルした内容】',
    itemsText(reservation),
    '',
    'またのご利用をお待ちしております。',
    'さとやまコーヒー',
  ].join('\n'));
}
