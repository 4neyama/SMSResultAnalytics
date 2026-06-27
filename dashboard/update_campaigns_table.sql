-- ==========================================================================
-- ENEOSモビリニア SMS送信分析ダッシュボード
-- 既存の campaigns テーブルにスプレッドシート型グリッドUI用のカラムを追加するパッチ SQL
-- ==========================================================================

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sent_count_report INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS criteria VARCHAR(50);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS timing VARCHAR(50);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS before_after VARCHAR(10);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS work_group VARCHAR(100);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS work_type_id VARCHAR(50);
