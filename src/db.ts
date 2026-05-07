import { Pool } from 'pg';
import crypto from 'crypto';

const pool = new Pool({
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
      store_id     INTEGER NOT NULL,
      customer_name  TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      pickup_date  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      cancel_token TEXT UNIQUE NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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
  stock: number;        // store_stock.current_count
  unit_weight_g: number;
};

export async function getStoreProducts(storeId: number): Promise<StoreProduct[]> {
  const result = await pool.query<StoreProduct>(`
    SELECT
      p.id   AS product_id,
      p.name,
      COALESCE(ss.current_count, 0) AS stock,
      p.unit_weight_g
    FROM products p
    LEFT JOIN store_stock ss
      ON ss.product_id = p.id AND ss.store_id = $1
    WHERE p.is_active = true
    ORDER BY p.name
  `, [storeId]);
  return result.rows;
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

// 複数商品まとめて在庫チェック
export async function checkAvailability(
  storeId: number,
  pickupDate: string,
  items: ReservationItem[],
): Promise<{ ok: boolean; conflicts: { product_name: string; available: number; requested: number }[] }> {
  const conflicts = [];
  for (const item of items) {
    const products = await getStoreProducts(storeId);
    const p = products.find(x => x.product_id === item.product_id);
    const stock = p?.stock ?? 0;
    const reserved = await getReservedCount(item.product_id, storeId, pickupDate);
    const available = Math.max(0, stock - reserved);
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
  const result = await pool.query(
    `UPDATE reservations SET status = 'cancelled' WHERE cancel_token = $1 AND status = 'pending' RETURNING id`,
    [token],
  );
  return (result.rowCount ?? 0) > 0;
}
