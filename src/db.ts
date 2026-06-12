import { Pool } from 'pg';
import crypto from 'crypto';

export const pool: Pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase') || process.env.DATABASE_URL?.includes('render')
    ? { rejectUnauthorized: false }
    : false,
});

export async function initDb(): Promise<void> {
  // reservations: 1予約 = 複数商品をまとめた親レコード
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id           SERIAL PRIMARY KEY,
      store_id     INTEGER NOT NULL DEFAULT 1,
      customer_name  TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      pickup_date  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      cancel_token TEXT UNIQUE NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // 既存テーブル向けマイグレーション: 古いスキーマには store_id 列が無いケースに対応
  await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS store_id INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cancel_token TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS reservations_cancel_token_uniq ON reservations(cancel_token)`);

  // 旧スキーマ（単商品予約）の NOT NULL 列を nullable にする。明細は reservation_items に分離済み。
  for (const col of ["product_id", "product_name", "quantity"]) {
    await pool.query(`ALTER TABLE reservations ALTER COLUMN ${col} DROP NOT NULL`).catch(() => {});
  }

  // reservation_items: 1予約に複数商品
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservation_items (
      id             SERIAL PRIMARY KEY,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      product_id     INTEGER NOT NULL,
      product_name   TEXT NOT NULL,
      quantity       INTEGER NOT NULL
    )
  `);

  // public スキーマの全テーブルに RLS を有効化（Supabase 経由の anon アクセスを遮断）。
  // 本アプリは postgres ロールで直接接続するため RLS をバイパスして従来通り動く。
  try {
    await pool.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT schemaname, tablename
          FROM pg_tables
          WHERE schemaname = 'public' AND rowsecurity = false
        LOOP
          EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
        END LOOP;
      END $$;
    `);
  } catch (e) {
    console.error('[startup] RLS有効化スキップ:', (e as Error).message);
  }
}

// ---- 型定義 ----

export type ReservationItem = {
  product_id: number;
  product_name: string;
  quantity: number;
};

export type Reservation = {
  id: number;
  store_id: number;
  store_name: string;
  customer_name: string;
  customer_email: string;
  pickup_date: string;
  status: string;
  cancel_token: string;
  created_at: string;
  items: ReservationItem[];
};

export type NewReservation = {
  store_id: number;
  customer_name: string;
  customer_email: string;
  pickup_date: string;
  items: ReservationItem[];
};

// ---- 在庫参照（在庫管理システムのテーブルを直接読む）----

export type StoreProduct = {
  product_id: number;
  name: string;
  flavor_note: string;  // 例: Mandarine・Pomegranate
  description: string;  // 商品説明（長文）
  stock: number;        // store_stock.current_count
  unit_weight_g: number;
  sale_price: number | null;  // 小売価格（円・税込）
  lot_info: string;     // ロット詳細（lot.description）
  has_label: boolean;   // ラベル画像があるか
  category_id: number | null;
  category_name: string;   // 表示用カテゴリ名（未分類なら ''）
  category_sort: number;
  roast_level: string;     // 焙煎度（浅煎り〜深煎り、未設定なら ''）
  taste_bright: number | null;  // 華やか 1-10
  taste_body: number | null;    // コク 1-10
  taste_sweet: number | null;   // 甘さ 1-10
  process_list: string;    // 配合ロットの精製方法（重複排除、" / " 区切り）
};

export async function getStoreProducts(storeId: number): Promise<StoreProduct[]> {
  const result = await pool.query<StoreProduct>(`
    SELECT
      p.id   AS product_id,
      p.name,
      COALESCE(p.flavor_note, '') AS flavor_note,
      COALESCE(p.description, '') AS description,
      COALESCE(ss.current_count, 0) AS stock,
      p.unit_weight_g,
      p.sale_price,
      (p.label_image IS NOT NULL) AS has_label,
      p.category_id,
      COALESCE(pc.name, '') AS category_name,
      COALESCE(pc.sort_order, 9999) AS category_sort,
      COALESCE(p.roast_level, '') AS roast_level,
      p.taste_bright,
      p.taste_body,
      p.taste_sweet,
      COALESCE((
        SELECT STRING_AGG(NULLIF(l.description, ''), ' / ')
        FROM product_lots pl
        JOIN lots l ON l.id = pl.lot_id
        WHERE pl.product_id = p.id
      ), '') AS lot_info,
      COALESCE((
        SELECT STRING_AGG(DISTINCT NULLIF(l.process, ''), ' / ')
        FROM product_lots pl
        JOIN lots l ON l.id = pl.lot_id
        WHERE pl.product_id = p.id
      ), '') AS process_list
    FROM products p
    LEFT JOIN store_stock ss
      ON ss.product_id = p.id AND ss.store_id = $1
    LEFT JOIN product_categories pc
      ON pc.id = p.category_id AND pc.is_active = true
    WHERE p.is_active = true
    ORDER BY COALESCE(pc.sort_order, 9999), p.name
  `, [storeId]);
  return result.rows;
}

export async function getProductLabel(productId: number): Promise<{ data: Buffer; mime: string } | null> {
  const res = await pool.query<{ label_image: Buffer | null; label_image_mime: string | null }>(
    `SELECT label_image, label_image_mime FROM products WHERE id = $1 AND label_image IS NOT NULL`,
    [productId],
  );
  if (!res.rows[0] || !res.rows[0].label_image) return null;
  return {
    data: res.rows[0].label_image,
    mime: res.rows[0].label_image_mime || 'image/jpeg',
  };
}

export async function getStores(): Promise<{ id: number; name: string }[]> {
  const result = await pool.query(`
    SELECT id, name FROM stores WHERE is_active = true ORDER BY id
  `);
  return result.rows;
}

// 特定商品・受取日・拠点の取り置き済み個数
export async function getReservedCount(
  productId: number,
  storeId: number,
  pickupDate: string,
): Promise<number> {
  const result = await pool.query<{ total: string }>(`
    SELECT COALESCE(SUM(ri.quantity), 0) AS total
    FROM reservation_items ri
    JOIN reservations r ON ri.reservation_id = r.id
    WHERE ri.product_id = $1
      AND r.store_id   = $2
      AND r.pickup_date = $3
      AND r.status != 'cancelled'
  `, [productId, storeId, pickupDate]);
  return parseInt(result.rows[0].total, 10);
}

// 複数商品まとめて在庫チェック（store_stock が予約即時減算されるため単純比較）
export async function checkAvailability(
  storeId: number,
  _pickupDate: string,
  items: ReservationItem[],
): Promise<{ ok: boolean; conflicts: { product_name: string; available: number; requested: number }[] }> {
  const products = await getStoreProducts(storeId);
  const conflicts = [];
  for (const item of items) {
    const p = products.find(x => x.product_id === item.product_id);
    const available = p?.stock ?? 0;
    if (item.quantity > available) {
      conflicts.push({ product_name: item.product_name, available, requested: item.quantity });
    }
  }
  return { ok: conflicts.length === 0, conflicts };
}

// ---- 予約操作 ----

export async function createReservation(data: NewReservation): Promise<Reservation> {
  const cancelToken = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{ id: number; cancel_token: string; created_at: string }>(
      `INSERT INTO reservations (store_id, customer_name, customer_email, pickup_date, cancel_token)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, cancel_token, created_at`,
      [data.store_id, data.customer_name, data.customer_email, data.pickup_date, cancelToken],
    );
    const reservationId = res.rows[0].id;

    for (const item of data.items) {
      await client.query(
        `INSERT INTO reservation_items (reservation_id, product_id, product_name, quantity)
         VALUES ($1, $2, $3, $4)`,
        [reservationId, item.product_id, item.product_name, item.quantity],
      );
      // 店頭在庫を即時減算（在庫管理側にも反映される）
      await client.query(
        `UPDATE store_stock
            SET current_count = GREATEST(current_count - $3, 0),
                updated_at    = NOW()
          WHERE store_id = $1 AND product_id = $2`,
        [data.store_id, item.product_id, item.quantity],
      );
    }
    await client.query('COMMIT');

    return getReservationById(reservationId) as Promise<Reservation>;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getReservationById(id: number): Promise<Reservation | null> {
  const res = await pool.query(`
    SELECT r.*, s.name AS store_name
    FROM reservations r
    JOIN stores s ON r.store_id = s.id
    WHERE r.id = $1
  `, [id]);
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  const items = await pool.query<ReservationItem>(
    `SELECT product_id, product_name, quantity FROM reservation_items WHERE reservation_id = $1`,
    [id],
  );
  return { ...r, items: items.rows };
}

export async function getReservationByToken(token: string): Promise<Reservation | null> {
  const res = await pool.query(`
    SELECT r.*, s.name AS store_name
    FROM reservations r
    JOIN stores s ON r.store_id = s.id
    WHERE r.cancel_token = $1
  `, [token]);
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  const items = await pool.query<ReservationItem>(
    `SELECT product_id, product_name, quantity FROM reservation_items WHERE reservation_id = $1`,
    [r.id],
  );
  return { ...r, items: items.rows };
}

export async function cancelReservation(token: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query<{ id: number; store_id: number }>(
      `UPDATE reservations SET status = 'cancelled'
        WHERE cancel_token = $1 AND status = 'pending'
        RETURNING id, store_id`,
      [token],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const { id, store_id } = upd.rows[0];
    // 在庫を戻す
    await client.query(
      `UPDATE store_stock ss
          SET current_count = ss.current_count + ri.quantity,
              updated_at    = NOW()
         FROM reservation_items ri
        WHERE ri.reservation_id = $1
          AND ss.product_id     = ri.product_id
          AND ss.store_id       = $2`,
      [id, store_id],
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
