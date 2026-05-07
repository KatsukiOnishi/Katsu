import 'dotenv/config';
import nodemailer from 'nodemailer';

async function main() {
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
  console.log('SMTP接続テスト中...', process.env.SMTP_HOST, process.env.SMTP_PORT, process.env.SMTP_USER);
  try {
    await t.verify();
    console.log('✅ SMTP接続OK');
    if (process.argv.includes('--send')) {
      const info = await t.sendMail({
        from: `"取り置きシステム動作確認" <${process.env.SMTP_USER}>`,
        to: process.env.STORE_EMAIL ?? process.env.SMTP_USER!,
        subject: '【テスト】SMTP動作確認',
        text: 'これはSMTP動作確認のテストメールです。受信できていれば設定OK。',
      });
      console.log('✅ 送信OK messageId=', info.messageId);
    } else {
      console.log('（送信テストもするには --send を付けて実行）');
    }
  } catch (e: any) {
    console.error('❌ SMTPエラー:', e?.message ?? e);
    if (e?.code) console.error('   code:', e.code);
    if (e?.response) console.error('   response:', e.response);
  }
}

main();
