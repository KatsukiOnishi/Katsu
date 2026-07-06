import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import type { Reservation } from './db';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.FROM_EMAIL ?? 'onboarding@resend.dev';
const FROM_NAME = 'さとやまコーヒー 取り置きシステム';

async function sendMailViaResend(to: string[], subject: string, text: string, html: string): Promise<void> {
  if (!resend) throw new Error('RESEND_API_KEY 未設定');
  const { error } = await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to,
    subject,
    text,
    html,
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}

async function sendMailViaSmtp(to: string[], subject: string, text: string, html: string): Promise<void> {
  await createTransport().sendMail({
    from: `"${FROM_NAME}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
  });
}

async function sendMail(to: string[], subject: string, text: string, html: string): Promise<void> {
  if (resend) return sendMailViaResend(to, subject, text, html);
  return sendMailViaSmtp(to, subject, text, html);
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

function formatDateTimeJst(value: string | Date): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

// ---- HTML メール部品（依存追加なし・インラインstyle）----

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

function emailLayout(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><body style="margin:0;padding:0;background:#f5f0eb;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;color:#2c1a0e;">
  <div style="background:#3b1f0a;color:#f5e6d3;border-radius:12px 12px 0 0;padding:16px 20px;font-size:16px;font-weight:bold;">さとやまコーヒー 取り置き</div>
  <div style="background:#ffffff;border-radius:0 0 12px 12px;padding:24px 20px;font-size:14px;line-height:1.9;">
${bodyHtml}
  </div>
  <p style="font-size:11px;color:#999999;margin-top:12px;text-align:center;">さとやまコーヒー（合同会社秋田里山デザイン）</p>
</div>
</body></html>`;
}

function detailRow(label: string, valueHtml: string): string {
  return `<tr>
<td style="padding:8px 10px;border:1px solid #e8dfd3;background:#fdf8f4;color:#8b6f4e;font-size:12px;white-space:nowrap;">${label}</td>
<td style="padding:8px 10px;border:1px solid #e8dfd3;">${valueHtml}</td>
</tr>`;
}

function detailTable(rowsHtml: string): string {
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;">${rowsHtml}</table>`;
}

function itemsTableHtml(reservation: Reservation): string {
  const rows = reservation.items.map(i => `<tr>
<td style="padding:8px 10px;border:1px solid #e8dfd3;">${escapeHtml(i.product_name)}</td>
<td style="padding:8px 10px;border:1px solid #e8dfd3;text-align:right;white-space:nowrap;">${i.quantity}個</td>
</tr>`).join('');
  return detailTable(rows);
}

// ---- 送信 ----

export async function sendConfirmationEmail(reservation: Reservation): Promise<void> {
  const pickupDate = formatDate(reservation.pickup_date);
  const totalItems = reservation.items.reduce((s, i) => s + i.quantity, 0);
  const text = [
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
  ].join('\n');

  const html = emailLayout(`
<p style="margin:0 0 12px;">${escapeHtml(reservation.customer_name)} 様</p>
<p style="margin:0 0 12px;">以下の内容で取り置きを承りました。</p>
${detailTable([
    detailRow('受付番号', `<strong>#${reservation.id}</strong>`),
    detailRow('受取拠点', escapeHtml(reservation.store_name)),
    detailRow('受け取り日', escapeHtml(pickupDate)),
    detailRow('合計', `${totalItems}点`),
  ].join(''))}
<p style="margin:12px 0 4px;font-weight:bold;">お取り置き内容</p>
${itemsTableHtml(reservation)}
<p style="margin:12px 0;">ご来店の際は受付番号をお知らせください。お待ちしております！</p>
<div style="text-align:center;margin:24px 0 8px;">
  <a href="${cancelUrl(reservation)}" style="display:inline-block;padding:12px 28px;background:#c0392b;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">予約をキャンセルする</a>
</div>
<p style="font-size:12px;color:#8b6f4e;text-align:center;margin:8px 0 0;">キャンセルは受取日の前日まで可能です。<br>当日のキャンセルは店舗へお電話ください。</p>
`);

  await sendMail([reservation.customer_email], '【取り置き受付完了】ご予約を承りました', text, html);
}

export type StoreNotificationOptions = {
  customerEmailFailed?: boolean;
};

export async function sendStoreNotificationEmail(
  reservation: Reservation,
  options: StoreNotificationOptions = {},
): Promise<void> {
  const recipients = splitEmails(process.env.STORE_EMAIL);
  if (recipients.length === 0) return;
  const pickupDate = formatDate(reservation.pickup_date);
  const totalItems = reservation.items.reduce((s, i) => s + i.quantity, 0);
  const createdAt = formatDateTimeJst(reservation.created_at);
  const failed = options.customerEmailFailed === true;

  const subject = `${failed ? '【要対応】' : ''}【新規取り置き】#${reservation.id} ${reservation.store_name} ${pickupDate} ${reservation.customer_name}様（${totalItems}点）`;

  const text = [
    ...(failed ? ['【要対応】お客様への確認メール送信失敗（手動連絡が必要）', ''] : []),
    '新しい取り置きが入りました。',
    '',
    `受付番号: #${reservation.id}`,
    `拠点: ${reservation.store_name}`,
    `お客様名: ${reservation.customer_name}`,
    `メール: ${reservation.customer_email}`,
    `受け取り日: ${pickupDate}`,
    `受付日時: ${createdAt}`,
    '',
    '【取り置き内容】',
    itemsText(reservation),
  ].join('\n');

  const warnHtml = failed
    ? `<div style="background:#fdecea;border:2px solid #e74c3c;border-radius:8px;padding:12px 14px;margin:0 0 16px;color:#b03a2e;font-weight:bold;">【要対応】お客様への確認メール送信失敗（手動連絡が必要）</div>`
    : '';
  const html = emailLayout(`
${warnHtml}
<p style="margin:0 0 12px;">新しい取り置きが入りました。</p>
${detailTable([
    detailRow('受付番号', `<strong>#${reservation.id}</strong>`),
    detailRow('拠点', escapeHtml(reservation.store_name)),
    detailRow('お客様名', escapeHtml(reservation.customer_name)),
    detailRow('メール', escapeHtml(reservation.customer_email)),
    detailRow('受け取り日', escapeHtml(pickupDate)),
    detailRow('受付日時', escapeHtml(createdAt)),
  ].join(''))}
<p style="margin:12px 0 4px;font-weight:bold;">取り置き内容</p>
${itemsTableHtml(reservation)}
`);

  await sendMail(recipients, subject, text, html);
}

export async function sendCancelEmail(reservation: Reservation): Promise<void> {
  const pickupDate = formatDate(reservation.pickup_date);
  const text = [
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
  ].join('\n');

  const html = emailLayout(`
<p style="margin:0 0 12px;">${escapeHtml(reservation.customer_name)} 様</p>
<p style="margin:0 0 12px;">以下の取り置きをキャンセルしました。</p>
${detailTable([
    detailRow('受付番号', `<strong>#${reservation.id}</strong>`),
    detailRow('受取拠点', escapeHtml(reservation.store_name)),
    detailRow('受け取り日', escapeHtml(pickupDate)),
  ].join(''))}
<p style="margin:12px 0 4px;font-weight:bold;">キャンセルした内容</p>
${itemsTableHtml(reservation)}
<p style="margin:12px 0 0;">またのご利用をお待ちしております。</p>
`);

  await sendMail([reservation.customer_email], `【キャンセル完了】受付番号 #${reservation.id}`, text, html);
}
