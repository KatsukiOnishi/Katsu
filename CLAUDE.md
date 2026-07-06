# coffee-reservation — Claude Code 向け取扱説明書

## 1. 役割

さとやまコーヒー（合同会社秋田里山デザイン）の **店頭取り置き予約** システム。顧客が拠点・受取日・商品・数量を指定して予約 → 確認メール送付 → 店舗にも通知 → 顧客はトークン付URLでキャンセル可能、という流れを担う。

責務範囲は予約管理のみ。在庫の事実（マスタ）は **在庫管理システム側の PostgreSQL テーブル（`products` / `store_stock` 等）** を同一DBから直接参照するため、本リポは在庫マスタを持たない（予約引当・キャンセル戻しで `store_stock.current_count` を増減はする）。

## 2. 技術スタック

| レイヤ | 採用技術 |
|---|---|
| 言語 | TypeScript 5 |
| フレームワーク | Express 4 |
| DB | PostgreSQL（Supabase または Render PostgreSQL）— `pg` で素のSQL（ORMなし） |
| メール | Resend SDK（優先） + nodemailer SMTP（フォールバック） |
| 在庫データソース | 在庫管理システムと共有の PostgreSQL（`store_stock` 等を直接参照） |
| フロント | 静的HTML（`public/index.html`） |
| デプロイ | Render（無料プラン、Node runtime） |

## 3. ディレクトリ構造

```
coffee-reservation/
├── src/
│   ├── server.ts           # Express アプリ、APIルート全部
│   ├── db.ts               # PostgreSQL接続、スキーマ初期化、予約CRUD、在庫参照
│   └── email.ts            # 確認・店舗通知・キャンセルの3種メール送信
├── scripts/
│   └── check_smtp.ts       # SMTP接続確認スクリプト
├── public/
│   └── index.html          # 予約フォーム（SPA的に動作）
├── render.yaml             # Render デプロイ設定
├── reservations.db         # （SQLiteは未使用、誤コミットの可能性）
├── package.json
└── tsconfig.json
```

## 4. データモデル（src/db.ts 内の DDL）

- **reservations**: 1予約 = 親レコード。`id`, `store_id`, `customer_name`, `customer_email`, `pickup_date`, `status`（`pending` / `cancelled` 等）, `cancel_token`（UUID、キャンセルURL用）, `created_at`。
- **reservation_items**: 1予約に対する複数商品。`reservation_id` で親に紐づく。`product_id`, `product_name`, `quantity`。
- 旧スキーマからのマイグレーションは `initDb()` 内で `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` で実施。

## 5. APIエンドポイント（src/server.ts）

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/stores` | 拠点一覧 |
| GET | `/api/inventory?store_id=` | 在庫一覧（DB `store_stock` 直接参照） |
| POST | `/api/availability` | 指定日・複数商品の残り在庫確認 |
| POST | `/api/reservations` | 予約作成 |
| GET | `/api/reservations?token=` | トークンで予約取得 |
| POST | `/api/reservations/cancel` | トークンでキャンセル |

## 6. ローカル実行

```bash
cd /Users/katsuki/Claude/coffee-reservation
npm install
cp .env.example .env  # 既存なら不要
npm run dev   # ts-node-dev で http://localhost:3000
```

## 7. 環境変数（.env）

- `DATABASE_URL`: PostgreSQL接続URL
- `APP_URL`: キャンセルURL生成用の絶対URL
- `RESEND_API_KEY` or `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS`: メール送信
- `STORE_EMAIL`: 店舗通知の宛先

## 8. デプロイ

Render の Node runtime、`render.yaml` で定義。`npm install && npm run build` → `npm start`。

## 9. 規約・既知の癖

- **ORMなし**: Prisma 等は使わず `pg` で素のSQL。スキーマ進化は `initDb()` 内の `ALTER` で漸進的に行う。
- **在庫はDB直接参照**: 在庫マスタは在庫管理システム側のテーブル（`store_stock` 等）。本リポは参照と、予約引当（条件付きUPDATEで原子的に減算）・キャンセル戻しの増減のみ行う。旧 Google Sheets 連携（`sheets.ts`）は廃止済み。
- **キャンセルトークン**: `crypto.randomUUID()` ベース、`cancel_token` カラムに保存。キャンセルURLは `{APP_URL}/cancel?token={token}`。
- **エラーハンドリング**: `try-catch + console.error` のみ。失敗通知（Slack/メール）なし。構造化ログなし。
- **メールフォールバック**: Resend 失敗時に SMTP に切り替わる。両方失敗するとログに残るだけで通知は飛ばない。
- **誤コミット**: `reservations.db` は SQLite ファイルだが実行時には未使用。`.gitignore` 検討余地あり。

## 10. 月次決算ハブとの関係（将来）

新規リポジトリ `satoyamacoffee-accounting` は本リポを **売上集計の補助データソース** として扱う想定。ただし金銭の授受は店頭決済または別途請求書発行なので、本リポからは「月次の予約件数 / 引当数量」のサマリを取得するだけで、freeeへの売上計上には直接使わない（売上はShopify or 店舗POS or freee請求書が SoT）。

エンドポイント追加が必要なら `GET /api/admin/reservations-summary?year=YYYY&month=MM` を新設する。

## 11. やってはいけないこと

- 在庫数の手動編集を本リポで直接やらない（SoT は在庫管理システム）。予約引当・キャンセル戻し以外で `store_stock` を書き換えない。
- `reservations.id` をURLに露出させない（キャンセルは必ず `cancel_token` 経由）。
- `customer_email` を平文ログに出力しない（個人情報）。
