import fetch from 'node-fetch';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID ?? '1lzP0WE8fiTrGQDSM-81FBkZ0UbbP1yBQPT7RoYHFW38';
// 西武秋田店シートのGID（シート名が日本語のためGIDで指定）
const SHEET_GID = process.env.SHEET_GID ?? '1272636296';

export type Product = {
  name: string;
  stock: number;
};

type CacheEntry = {
  data: Product[];
  fetchedAt: number;
};

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分

async function fetchSheetCsv(): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets fetch failed: ${res.status}`);
  const text = await res.text();
  return parseCsv(text);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols: string[] = [];
    let inQuote = false;
    let current = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === ',' && !inQuote) {
        cols.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cols.push(current.trim());
    rows.push(cols);
  }
  return rows;
}

function parseInventory(rows: string[][]): Product[] {
  const products: Product[] = [];

  // 「焙煎豆 (個)」カテゴリの「通常」セクションを探す
  let inCategory = false;
  let inNormal = false;

  for (const row of rows) {
    const col0 = row[0] ?? '';
    const col1 = row[1] ?? '';

    if (col0.includes('焙煎豆') && col0.includes('個')) {
      inCategory = true;
    } else if (inCategory && col0 !== '' && !col0.includes('焙煎豆')) {
      // 別カテゴリに入ったら終了
      inCategory = false;
      inNormal = false;
    }

    if (!inCategory) continue;

    if (col1 === '通常' || col1 === '') {
      if (col1 === '通常') inNormal = true;
      // 「その他」に入ったら通常セクション終了
    } else if (col1 !== '') {
      inNormal = false;
    }

    if (!inNormal) continue;

    // 商品名と在庫数を取得（商品名が空でないこと）
    // 列レイアウト: [カテゴリー, サブカテゴリー, 安全在庫, 商品名, 在庫数, ...]
    const name = findProductName(row);
    if (!name) continue;

    const stock = findLatestStock(row) ?? 0;
    products.push({ name, stock });
  }

  return products;
}

function findProductName(row: string[]): string | null {
  // 西武秋田店シートの列構造:
  // col0=カテゴリー, col1=サブカテゴリー, col2=安全在庫, col3=商品名, col4以降=日付別在庫
  const name = row[3];
  if (name && !/^\d/.test(name) && !/^¥/.test(name)) {
    return name;
  }
  return null;
}

function findLatestStock(row: string[]): number | null {
  // col4以降の右端から最初の数値が最新の在庫数（日付ごとの在庫履歴から最新を取得）
  for (let i = row.length - 1; i >= 4; i--) {
    const val = row[i];
    if (val !== undefined && val !== '' && /^\d+$/.test(val)) {
      return parseInt(val, 10);
    }
  }
  return null;
}

export async function getInventory(): Promise<Product[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const rows = await fetchSheetCsv();
  const products = parseInventory(rows);

  cache = { data: products, fetchedAt: now };
  return products;
}

export function invalidateCache(): void {
  cache = null;
}
