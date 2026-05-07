import nodemailer from 'nodemailer';
import type { Reservation } from './db';

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${y}年${m}月${d}日`;
}

export async function sendConfirmationEmail(reservation: Reservation): Promise<void> {
  const transporter = createTransport();
  const pickupDate = formatDate(reservation.pickup_date);

  await transporter.sendMail({
    from: `"コーヒー取り置きシステム" <${process.env.SMTP_USER}>`,
    to: reservation.customer_email,
    subject: '【取り置き受付完了】ご予約を承りました',
    text: [
      `${reservation.customer_name} 様`,
      '',
      '以下の内容で取り置きを承りました。',
      '',
      `商品: ${reservation.product_name}`,
      `個数: ${reservation.quantity}個`,
      `受け取り日: ${pickupDate}`,
      `受付番号: ${reservation.id}`,
      '',
      'ご来店の際は受付番号をお知らせください。',
      'お待ちしております！',
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
    subject: `【新規取り置き】${reservation.product_name} ${reservation.quantity}個`,
    text: [
      '新しい取り置きが入りました。',
      '',
      `受付番号: ${reservation.id}`,
      `お客様名: ${reservation.customer_name}`,
      `メール: ${reservation.customer_email}`,
      `商品: ${reservation.product_name}`,
      `個数: ${reservation.quantity}個`,
      `受け取り日: ${pickupDate}`,
      `受付日時: ${reservation.created_at}`,
    ].join('\n'),
  });
}
