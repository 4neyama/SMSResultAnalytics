-- ==========================================================================
-- ENEOSモビリニア SMS送信分析システム
-- Supabase マイグレーション SQLスクリプト (sms_deliveriesテーブルへの車両ナンバー追加)
-- ==========================================================================

-- 1. sms_deliveries テーブルへ車両ナンバーの4分割項目カラムを追加
ALTER TABLE sms_deliveries 
    ADD COLUMN IF NOT EXISTS car_land VARCHAR(50),
    ADD COLUMN IF NOT EXISTS car_class VARCHAR(50),
    ADD COLUMN IF NOT EXISTS car_kana VARCHAR(50),
    ADD COLUMN IF NOT EXISTS car_num VARCHAR(50);
