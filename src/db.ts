import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(__dirname, '..', 'reservations.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    pickup_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    status TEXT NOT NULL DEFAULT 'pending'
  )
`);

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

export function createReservation(data: NewReservation): Reservation {
  const stmt = db.prepare(`
    INSERT INTO reservations (customer_name, customer_email, product_name, quantity, pickup_date)
    VALUES (@customer_name, @customer_email, @product_name, @quantity, @pickup_date)
  `);
  const result = stmt.run(data);
  return getReservationById(result.lastInsertRowid as number)!;
}

export function getReservationById(id: number): Reservation | undefined {
  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as Reservation | undefined;
}

// 特定商品・特定受取日の取り置き済み個数合計
export function getReservedCount(productName: string, pickupDate: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total
    FROM reservations
    WHERE product_name = ? AND pickup_date = ? AND status != 'cancelled'
  `).get(productName, pickupDate) as { total: number };
  return row.total;
}

export function getAllReservations(): Reservation[] {
  return db.prepare('SELECT * FROM reservations ORDER BY created_at DESC').all() as Reservation[];
}
