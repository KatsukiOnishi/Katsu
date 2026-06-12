import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import {
  initDb,
  getStores,
  getStoreProducts,
  getReservedCount,
  checkAvailability,
  createReservation,
  getReservationByToken,
  cancelReservation,
  getProductLabel,
} from './db';
import { sendConfirmationEmail, sendStoreNotificationEmail, sendCancelEmail, verifySmtp } from './email';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 商品ラベル画像（在庫管理DBから直接読む）
app.get('/api/products/:id/label', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send('invalid id');
  try {
    const label = await getProductLabel(id);
    if (!label) return res.status(404).send('not found');
    res.setHeader('Content-Type', label.mime);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(label.data);
  } catch (err) {
    console.error('ラベル取得エラー:', err);
    res.status(500).send('error');
  }
});

// 拠点一覧
app.get('/api/stores', async (_req, res) => {
  try {
    const stores = await getStores();
    res.json({ stores });
  } catch (err) {
    console.error('拠点取得エラー:', err);
    res.status(500).json({ error: '拠点情報の取得に失敗しました' });
  }
});

// 在庫一覧（拠点指定）
app.get('/api/inventory', async (req, res) => {
  const storeId = parseInt(req.query.store_id as string);
  if (!storeId) return res.status(400).json({ error: 'store_id は必須です' });
  try {
    const products = await getStoreProducts(storeId);
    res.json({ products });
  } catch (err) {
    console.error('在庫取得エラー:', err);
    res.status(500).json({ error: '在庫情報の取得に失敗しました' });
  }
});

// 日付別の残り在庫確認（複数商品）
app.post('/api/availability', async (req, res) => {
  const { store_id, pickup_date, items } = req.body;
  if (!store_id || !pickup_date || !Array.isArray(items)) {
    return res.status(400).json({ error: 'store_id, pickup_date, items は必須です' });
  }
  try {
    const result = await checkAvailability(store_id, pickup_date, items);
    // 各商品の残り在庫も返す
    const products = await getStoreProducts(store_id);
    const availability = await Promise.all(
      items.map(async (item) => {
        const p = products.find(x => x.product_id === item.product_id);
        const reserved = await getReservedCount(item.product_id, store_id, pickup_date);
        const available = Math.max(0, (p?.stock ?? 0) - reserved);
        return { product_id: item.product_id, product_name: item.product_name, available };
      }),
    );
    res.json({ ...result, availability });
  } catch (err) {
    console.error('在庫確認エラー:', err);
    res.status(500).json({ error: '在庫確認に失敗しました' });
  }
});

// 予約作成
app.post('/api/reservations', async (req, res) => {
  const { store_id, customer_name, customer_email, pickup_date, items } = req.body;

  if (!store_id || !customer_name || !customer_email || !pickup_date || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '全項目を入力してください' });
  }
  if (!customer_email.includes('@')) {
    return res.status(400).json({ error: 'メールアドレスが正しくありません' });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const twoWeeksLater = new Date(today);
  twoWeeksLater.setDate(today.getDate() + 14);
  const pickup = new Date(pickup_date);
  if (pickup < today || pickup > twoWeeksLater) {
    return res.status(400).json({ error: '受け取り日は今日から2週間以内で指定してください' });
  }

  for (const item of items) {
    if (!item.product_id || !item.product_name || !Number.isInteger(item.quantity) || item.quantity < 1) {
      return res.status(400).json({ error: '商品情報が不正です' });
    }
  }

  try {
    const { ok, conflicts } = await checkAvailability(store_id, pickup_date, items);
    if (!ok) {
      const msgs = conflicts.map(c => `「${c.product_name}」残り${c.available}個（${c.requested}個希望）`);
      return res.status(409).json({ error: `在庫が不足しています: ${msgs.join('、')}`, conflicts });
    }

    const reservation = await createReservation({ store_id, customer_name, customer_email, pickup_date, items });

    res.status(201).json({ reservation });

    sendConfirmationEmail(reservation).catch(e =>
      console.error('[mail] お客様確認メール送信失敗:', e?.message ?? e),
    );
    sendStoreNotificationEmail(reservation).catch(e =>
      console.error('[mail] 店舗通知メール送信失敗:', e?.message ?? e),
    );
  } catch (err) {
    console.error('予約エラー:', err);
    res.status(500).json({ error: '予約の受付に失敗しました' });
  }
});

// キャンセル確認ページ（HTML）
app.get('/cancel/:token', async (req, res) => {
  const reservation = await getReservationByToken(req.params.token);
  if (!reservation) {
    return res.status(404).send('予約が見つかりません');
  }
  if (reservation.status === 'cancelled') {
    return res.send(cancelPageHtml(reservation, 'already'));
  }
  res.send(cancelPageHtml(reservation, 'confirm'));
});

// キャンセル実行
app.post('/cancel/:token', async (req, res) => {
  const reservation = await getReservationByToken(req.params.token);
  if (!reservation) return res.status(404).send('予約が見つかりません');
  if (reservation.status === 'cancelled') return res.send(cancelPageHtml(reservation, 'already'));

  const ok = await cancelReservation(req.params.token);
  if (!ok) return res.status(409).send('キャンセルに失敗しました');

  res.send(cancelPageHtml(reservation, 'done'));

  sendCancelEmail(reservation).catch(e =>
    console.error('[mail] キャンセルメール送信失敗:', e?.message ?? e),
  );
});

function cancelPageHtml(reservation: Awaited<ReturnType<typeof getReservationByToken>>, mode: 'confirm' | 'done' | 'already'): string {
  const r = reservation!;
  const itemsHtml = r.items.map(i => `<li>${i.product_name} × ${i.quantity}個</li>`).join('');
  const [y, m, d] = r.pickup_date.split('-');
  const dateStr = `${y}年${parseInt(m)}月${parseInt(d)}日`;

  const content = mode === 'confirm'
    ? `<p>以下の取り置きをキャンセルしますか？</p>
       <div class="details">
         <b>#${r.id}</b> ${r.store_name} / ${dateStr}<br>
         <ul>${itemsHtml}</ul>
       </div>
       <form method="post">
         <button type="submit" class="btn-cancel">キャンセルする</button>
       </form>`
    : mode === 'done'
    ? `<p class="done">✅ キャンセルが完了しました。<br>確認メールをお送りしました。</p>`
    : `<p class="done">この予約はすでにキャンセル済みです。</p>`;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>取り置きキャンセル</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#f5f0eb;color:#2c1a0e;display:flex;justify-content:center;padding:40px 16px}
    .card{background:#fff;border-radius:14px;padding:28px;max-width:480px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    h1{font-size:1.2rem;margin-bottom:16px;color:#3b1f0a}
    .details{background:#fdf8f4;border-radius:8px;padding:14px;margin:14px 0;font-size:.9rem;line-height:1.8}
    ul{margin:8px 0 0 16px}
    .btn-cancel{width:100%;padding:12px;background:#c0392b;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:12px}
    .done{color:#27ae60;font-weight:600;line-height:1.8}
    a{display:inline-block;margin-top:16px;color:#8b4513;font-size:.9rem}
  </style></head><body>
  <div class="card">
    <h1>☕ 取り置きキャンセル</h1>
    ${content}
    <a href="/">トップへ戻る</a>
  </div></body></html>`;
}

initDb()
  .then(() => {
    verifySmtp();
    app.listen(PORT, () => console.log(`サーバー起動: http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('DB初期化失敗:', err);
    process.exit(1);
  });
