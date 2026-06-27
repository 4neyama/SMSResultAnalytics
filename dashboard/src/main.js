// CSSの読み込み
import './style.css';

// 外部ライブラリのインポート
import { createClient } from '@supabase/supabase-js';
import { Chart, registerables } from 'chart.js';
import Papa from 'papaparse';

// Chart.js のプラグイン・エレメント等を一括登録
Chart.register(...registerables);

// 既存の app.js がグローバル変数を参照しているため、window オブジェクトにバインドする
window.supabase = { createClient };
window.Chart = Chart;
window.Papa = Papa;

// アプリケーション本体のロジック（app.js）を読み込む
import './app.js';
