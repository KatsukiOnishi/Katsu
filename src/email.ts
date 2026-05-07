import nodemailer from 'nodemailer';
import type { Reservation } from './db';

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
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mail] SMTP_USER/SMTP_PASS が未設定。メール送信は無効です。');
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

export async function sendConfirmationEmail(reservation: Reservation): Promise<void> {
  const transporter = createTransport();
  const pickupDate = formatDate(reservation.pickup_date);
  const totalItems = reservation.items.reduce((s, i) => s + i.quantity, 0);

  await transporter.sendMail({
    from: `"さとやまコーヒー 取り置きシステム" <${process.env.SMTP_USER}>`,
    to: reservation.customer_email,
    subject: '【取り置き受付完了】ご予約を承りました',
    text: [
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
    ].join('\n'),
  });
}

export async function sendStoreNotificationEmail(reservation: Reservation): Promise<void> {
  const storeEmail = process.env.STORE_EMAIL;
  if (!storeEmail) return;

  const transporter = createTransport();
  const pickupDate = formatDate(reservation.pickup_date);

  await transporter.sendMail({
    from: `"取り置きシステム" <${process.env.SMTP_USER}>`,
    to: storeEmail,
    subject: `【新規取り置き】${reservation.store_name} ${pickupDate} ${reservation.items.length}種`,
    text: [
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
    ].join('\n'),
  });
}

export async function sendCancelEmail(reservation: Reservation): Promise<void> {
  const transporter = createTransport();
  const pickupDate = formatDate(reservation.pickup_date);

  await transporter.sendMail({
    from: `"さとやまコーヒー 取り置きシステム" <${process.env.SMTP_USER}>`,
    to: reservation.customer_email,
    subject: `【キャンセル完了】受付番号 #${reservation.id}`,
    text: [
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
    ].join('\n'),
  });
}
