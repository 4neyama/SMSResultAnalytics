-- 月別予約集計用のビューを作成
CREATE OR REPLACE VIEW monthly_reservation_summary AS
SELECT 
  TO_CHAR(reception_date, 'YYYY-MM') AS month,
  store_code,
  route,
  (previous_reception_date IS NOT NULL) AS rescheduled,
  COUNT(*)::bigint AS count
FROM reservations
GROUP BY TO_CHAR(reception_date, 'YYYY-MM'), store_code, route, (previous_reception_date IS NOT NULL);

-- ビューに対する読み取り権限を付与
GRANT SELECT ON monthly_reservation_summary TO anon, authenticated, service_role;
