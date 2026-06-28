-- ==========================================================================
-- ENEOSモビリニア SMS送信分析システム
-- Supabase マイグレーション SQLスクリプト (インポートログ履歴テーブルの追加)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS import_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imported_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    row_count INTEGER NOT NULL,
    import_type VARCHAR(50) NOT NULL,
    created_by VARCHAR(100)
);

-- ロールへのアクセス権付与
GRANT ALL ON import_logs TO anon, authenticated, service_role;

-- 検索を高速にするためのインデックス
CREATE INDEX IF NOT EXISTS idx_import_logs_imported_at ON import_logs(imported_at DESC);
