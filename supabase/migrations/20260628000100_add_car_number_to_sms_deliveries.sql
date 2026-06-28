-- ==========================================================================
-- ENEOSモビリニア SMS送信分析システム
-- Supabase マイグレーション SQLスクリプト (sms_deliveriesテーブルへの車両ナンバー追加)
-- ==========================================================================

-- 1. sms_deliveries テーブルへ車両ナンバー（car_number）カラムを追加
ALTER TABLE sms_deliveries 
    ADD COLUMN IF NOT EXISTS car_number VARCHAR(100);
