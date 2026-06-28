-- ==========================================================================
-- ENEOSモビリニア SMS送信分析システム
-- Supabase データベース構築用 SQLスクリプト (配信親テーブル＆マッピング対応版)
-- ==========================================================================

-- 1. テーブルの削除（初期化用、依存関係の逆順で削除）
DROP TABLE IF EXISTS category_mappings;
DROP TABLE IF EXISTS store_own_sms;
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS sms_deliveries;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS stores;

-- 2. 店舗マスタテーブルの作成
CREATE TABLE stores (
    store_code VARCHAR(50) PRIMARY KEY,       -- 店舗ID (nskn店舗ID)
    ss_code VARCHAR(50),                      -- SSコード (7桁)
    store_name VARCHAR(100) NOT NULL,          -- 店舗名
    area_name VARCHAR(50) NOT NULL,            -- エリア名 (例: 中国1G)
    display_order INTEGER DEFAULT 0,          -- 表示順 (新規追加)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. 配信親テーブル（キャンペーン）の作成
CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_date DATE NOT NULL,               -- 配信日
    category VARCHAR(50) NOT NULL,             -- カテゴリ (オイル, コーティング, 洗車, 車検, 点検)
    sent_count_report INTEGER DEFAULT 0 NOT NULL, -- 配信数 (報告) 手入力
    criteria VARCHAR(50),                      -- 基準 (満了日, 実施日 など)
    timing VARCHAR(50),                        -- タイミング (4ヶ月, 6ヶ月 など)
    before_after VARCHAR(10),                  -- 前/後 (前, 後)
    work_group VARCHAR(100),                   -- 予約される作業 (事前見積 など)
    campaign_name VARCHAR(150) NOT NULL,       -- キャンペーン・配信名 (例: 20260422_オイル交換案内)
    sms_text TEXT,                             -- 実際の送信文章内容（任意）
    work_type_id VARCHAR(50),                  -- 作業種別ID (新規追加)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 4. SMS配信実績（明細）テーブルの作成 (個人情報はハッシュ化・除外済み)
CREATE TABLE sms_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, -- 配信親への紐づけ
    store_code VARCHAR(50) REFERENCES stores(store_code) ON DELETE CASCADE,
    hashed_customer_id VARCHAR(64) NOT NULL,   -- SHA-256で不可逆ハッシュ化した顧客IDまたは車台番号
    sms_count INTEGER DEFAULT 1 NOT NULL,      -- 通数
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 5. 予約実績テーブルの作成 (個人情報はハッシュ化・除外済み)
CREATE TABLE reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id VARCHAR(50) NOT NULL UNIQUE,  -- 予約ID (一意キー)
    reception_date DATE NOT NULL,              -- 受付日
    previous_reception_date DATE,              -- 変更前の受付日 (日程変更時に自動退避)
    work_group VARCHAR(50) NOT NULL,           -- 作業グループ (洗車, オイル交換, コーティング, 車検, 点検など)
    store_code VARCHAR(50) REFERENCES stores(store_code) ON DELETE CASCADE,
    hashed_customer_id VARCHAR(64),            -- SHA-256で不可逆ハッシュ化した連携先システム顧客ID等
    route VARCHAR(100),                        -- 予約経路 (SMS予約, LINE予約, 入庫予約など)
    route_store VARCHAR(100),                  -- 予約経路_店頭入力用 (EMO_WEBなど)
    status VARCHAR(50),                        -- ステータス (本予約, 予約確認済みなど)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 6. 店舗独自SMSテーブルの作成
CREATE TABLE store_own_sms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_month VARCHAR(7) NOT NULL,        -- 配信月 (YYYY-MM)
    store_code VARCHAR(50) REFERENCES stores(store_code) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL,             -- カテゴリ
    sms_count INTEGER DEFAULT 0 NOT NULL,      -- 店舗SMS送信数
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    UNIQUE (delivery_month, store_code, category)
);

-- 7. 集計ロジック（カテゴリマッピング）設定テーブルの作成
CREATE TABLE category_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(50) NOT NULL,             -- 配信カテゴリ名
    work_group VARCHAR(50) NOT NULL,           -- 予約作業グループ名
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    UNIQUE (category, work_group)              -- 重複防止のユニーク制約
);

-- 8. 初期マッピングルールの登録
INSERT INTO category_mappings (category, work_group) VALUES
('オイル', 'オイル交換'),
('コーティング', 'コーティング'),
('コーティング', '洗車'),               -- コーティング案内で洗車予約も成果とする（米山様ご指摘の仕様）
('洗車', '洗車'),
('車検', '車検'),
('車検', '事前点検'),
('点検', '点検')
ON CONFLICT (category, work_group) DO NOTHING;

-- 8.1. 不明店舗 (unknown) の登録
INSERT INTO stores (store_code, ss_code, store_name, area_name) VALUES
('unknown', 'unknown', '不明な店舗', '不明')
ON CONFLICT (store_code) DO NOTHING;

-- 9. インデックスの作成（クエリの高速化用）
CREATE INDEX idx_sms_deliveries_campaign ON sms_deliveries(campaign_id);
CREATE INDEX idx_sms_deliveries_store ON sms_deliveries(store_code);
CREATE INDEX idx_sms_deliveries_hash ON sms_deliveries(hashed_customer_id);

CREATE INDEX idx_campaigns_date ON campaigns(delivery_date);

CREATE INDEX idx_reservations_reception ON reservations(reception_date);
CREATE INDEX idx_reservations_store ON reservations(store_code);
CREATE INDEX idx_reservations_hash ON reservations(hashed_customer_id);

CREATE INDEX idx_store_own_sms_month ON store_own_sms(delivery_month);

-- 10. 行レベルセキュリティ (Row Level Security: RLS) の有効化
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_own_sms ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_mappings ENABLE ROW LEVEL SECURITY;

-- 11. RLS ポリシーの定義
-- (A) 匿名ユーザー(anon) および ログインユーザーは、すべてのデータを読み取り(SELECT)可能にする
CREATE POLICY "Allow select for everyone" ON stores FOR SELECT USING (true);
CREATE POLICY "Allow select for everyone" ON campaigns FOR SELECT USING (true);
CREATE POLICY "Allow select for everyone" ON sms_deliveries FOR SELECT USING (true);
CREATE POLICY "Allow select for everyone" ON reservations FOR SELECT USING (true);
CREATE POLICY "Allow select for everyone" ON store_own_sms FOR SELECT USING (true);
CREATE POLICY "Allow select for everyone" ON category_mappings FOR SELECT USING (true);

-- (B) ログインした管理者(authenticatedロール)のみ、データの追加・更新・削除を許可する
CREATE POLICY "Allow write for admin" ON stores FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for admin" ON campaigns FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for admin" ON sms_deliveries FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for admin" ON reservations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for admin" ON store_own_sms FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for admin" ON category_mappings FOR ALL TO authenticated USING (true) WITH CHECK (true);
