import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { getInventory } from './sheets';
import { createReservation, getReservedCount, initDb } from './db';
import { sendConfirmationEmail, sendStoreNotificationEmail } from './email';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 在庫一覧取得
app.get('/api/inventory', async (_req, res) => {
  try {
    const products = await getInventory();
    res.json({ products });
  } catch (err) {
    console.error('在庫取得エラー:', err);
    res.status(500).json({ error: '在庫情報の取得に失敗しました' });
  }
});

// 受取日ごとの残り在庫取得
app.get('/api/availability', async (req, res) => {
  const { product, date } = req.query;
  if (typeof product !== 'string' || typeof date !== 'string') {
    return res.status(400).json({ error: 'product と date は必須です' });
  }

  try {
    const products = await getInventory();
    const item = products.find((p) => p.name === product);
    if (!item) return res.status(404).json({ error: '商品が見つかりません' });

    const reserved = await getReservedCount(product, date);
    const available = Math.max(0, item.stock - reserved);
    res.json({ product, date, available });
  } catch (err) {
    console.error('在庫確認エラー:', err);
    res.status(500).json({ error: '在庫確認に失敗しました' });
  }
});

// 取り置き予約送信
app.post('/api/reservations', async (req, res) => {
  const { customer_name, customer_email, product_name, quantity, pickup_date } = req.body;

  if (!customer_name || !customer_email || !product_name || !quantity || !pickup_date) {
    return res.status(400).json({ error: '全項目を入力してください' });
  }

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ error: '個数が不正です' });
  }

  // 受取日バリデーション（今日〜2週間後）
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const twoWeeksLater = new Date(today);
  twoWeeksLater.setDate(today.getDate() + 14);
  const pickup = new Date(pickup_date);
  if (pickup < today || pickup > twoWeeksLater) {
    return res.status(400).json({ error: '受け取り日は今日から2週間以内で指定してください' });
  }

  try {
    const products = await getInventory();
    const item = products.find((p) => p.name === product_name);
    if (!item) return res.status(404).json({ error: '商品が見つかりません' });

    const reserved = await getReservedCount(product_name, pickup_date);
    const available = item.stock - reserved;
    if (qty > available) {
      return res.status(409).json({
        error: `在庫が不足しています（残り${available}個）`,
        available,
      });
    }

    const reservation = await createReservation({
      customer_name,
      customer_email,
      product_name,
      quantity: qty,
      pickup_date,
    });

    // メール送信（失敗しても予約は確定）
    await Promise.allSettled([
      sendConfirmationEmail(reservation),
      sendStoreNotificationEmail(reservation),
    ]);

    res.status(201).json({ reservation });
  } catch (err) {
    console.error('予約エラー:', err);
    res.status(500).json({ error: '予約の受付に失敗しました' });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`サーバー起動: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB初期化失敗:', err);
    process.exit(1);
  });
