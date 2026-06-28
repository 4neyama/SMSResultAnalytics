-- ==========================================================================
-- ENEOSモビリニア SMS送信分析システム
-- Supabase マイグレーション SQLスクリプト (日時項目 & gnoteハウスキーピング項目 & 車両ナンバー)
-- ==========================================================================

-- 1. reservations テーブルへ新規カラムを追加
ALTER TABLE reservations 
    ADD COLUMN IF NOT EXISTS booking_date DATE,
    ADD COLUMN IF NOT EXISTS visit_datetime TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS previous_visit_datetime TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS pit_reservation_datetime TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS car_number VARCHAR(100),
    ADD COLUMN IF NOT EXISTS gnote_created_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS gnote_updated_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS gnote_created_by VARCHAR(100),
    ADD COLUMN IF NOT EXISTS gnote_updated_by VARCHAR(100);

-- 2. 既存データがある場合の移行（reception_date -> visit_datetime 等）
UPDATE reservations 
SET 
    booking_date = COALESCE(booking_date, reception_date),
    visit_datetime = COALESCE(visit_datetime, CAST(reception_date AS TIMESTAMP WITH TIME ZONE)),
    previous_visit_datetime = COALESCE(previous_visit_datetime, CAST(previous_reception_date AS TIMESTAMP WITH TIME ZONE))
WHERE reception_date IS NOT NULL;

-- 3. 旧ビュー monthly_summary_view および monthly_reservation_summary をドロップ (依存関係解消のため)
DROP VIEW IF EXISTS monthly_summary_view;
DROP VIEW IF EXISTS monthly_reservation_summary;

-- 4. 旧カラムを削除
ALTER TABLE reservations 
    DROP COLUMN IF EXISTS reception_date,
    DROP COLUMN IF EXISTS previous_reception_date;

-- 5. 新しい月別予約サマリービューの作成 (visit_datetime を基準にする)
CREATE OR REPLACE VIEW monthly_summary_view AS
SELECT 
    TO_CHAR(visit_datetime AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month,
    COUNT(*) AS count
FROM reservations
WHERE visit_datetime IS NOT NULL
GROUP BY TO_CHAR(visit_datetime AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM');

GRANT SELECT ON monthly_summary_view TO anon, authenticated, service_role;

-- 6. 新しい月別予約集計用のビュー (monthly_reservation_summary) の再作成
CREATE OR REPLACE VIEW monthly_reservation_summary AS
SELECT 
  TO_CHAR(visit_datetime AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month,
  store_code,
  route,
  (previous_visit_datetime IS NOT NULL) AS rescheduled,
  COUNT(*)::bigint AS count
FROM reservations
WHERE visit_datetime IS NOT NULL
GROUP BY TO_CHAR(visit_datetime AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM'), store_code, route, (previous_visit_datetime IS NOT NULL);

GRANT SELECT ON monthly_reservation_summary TO anon, authenticated, service_role;

-- 7. インデックスの再作成・追加
DROP INDEX IF EXISTS idx_reservations_reception;
CREATE INDEX IF NOT EXISTS idx_reservations_booking ON reservations(booking_date);
CREATE INDEX IF NOT EXISTS idx_reservations_visit ON reservations(visit_datetime);
CREATE INDEX IF NOT EXISTS idx_reservations_gnote_created ON reservations(gnote_created_at);
