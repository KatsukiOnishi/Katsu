import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : false,
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      pickup_date TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'pending'
    )
  `);
}

export type Reservation = {
  id: number;
  customer_name: string;
  customer_email: string;
  product_name: string;
  quantity: number;
  pickup_date: string;
  created_at: string;
  status: string;
};

export type NewReservation = Omit<Reservation, 'id' | 'created_at' | 'status'>;

export async function createReservation(data: NewReservation): Promise<Reservation> {
  const result = await pool.query<Reservation>(
    `INSERT INTO reservations (customer_name, customer_email, product_name, quantity, pickup_date)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.customer_name, data.customer_email, data.product_name, data.quantity, data.pickup_date]
  );
  return result.rows[0];
}

// 特定商品・特定受取日の取り置き済み個数合計
export async function getReservedCount(productName: string, pickupDate: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS total
     FROM reservations
     WHERE product_name = $1 AND pickup_date = $2 AND status != 'cancelled'`,
    [productName, pickupDate]
  );
  return parseInt(result.rows[0].total, 10);
}

export async function getAllReservations(): Promise<Reservation[]> {
  const result = await pool.query<Reservation>(
    'SELECT * FROM reservations ORDER BY created_at DESC'
  );
  return result.rows;
}
