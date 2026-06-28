-- ==========================================================================
-- ENEOSモビリニア SMS送信分析システム
-- Supabase マイグレーション SQLスクリプト (月別集計用ビュー monthly_reservation_summary_v2 の作成)
-- ==========================================================================

-- 1. 新しい月別・店舗別・経路別の予約集計ビューの作成 (visit_datetime と booking_date の両方をサポート)
CREATE OR REPLACE VIEW monthly_reservation_summary_v2 AS
SELECT 
  TO_CHAR(visit_datetime AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS visit_month,
  TO_CHAR(booking_date, 'YYYY-MM') AS booking_month,
  store_code,
  route,
  (previous_visit_datetime IS NOT NULL) AS rescheduled,
  COUNT(*)::bigint AS count
FROM reservations
GROUP BY 
  TO_CHAR(visit_datetime AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM'), 
  TO_CHAR(booking_date, 'YYYY-MM'), 
  store_code, 
  route, 
  (previous_visit_datetime IS NOT NULL);

-- ロールへのアクセス権付与
GRANT SELECT ON monthly_reservation_summary_v2 TO anon, authenticated, service_role;
