/* ==========================================================================
   ENEOSモビリニア SMS送信分析ダッシュボード アプリケーションロジック (app.js)
   ========================================================================== */

// 1. グローバル設定と状態管理
let supabaseClient = null;
let currentTab = 'dashboard-view';
let isAdmin = false;
let selectedFile = null;
let activeUploadingCampaignId = null; // CSVアップロード中のキャンペーンIDを保持
let isDataLoading = false; // 💡 二重ロード防止ロックフラグ
let pendingUploadFile = null; // 💡 再ログイン自動再開用の保留ファイル
let pendingUploadCampaignId = null; // 💡 再ログイン自動再開用の保留キャンペーンID

// キャッシュデータ
let storesCache = [];
let campaignsCache = [];
let smsDeliveriesCache = [];
let reservationsCache = [];
let reservationsListCache = [];
let storeOwnSmsCache = [];
let categoryMappingsCache = [];

// 💡 静的補完マッピング辞書（店舗名 -> SSコード）
const MASTER_STORE_NAME_TO_SS_CODE = {
    "羽島": "8003022",
    "広江": "1015874",
    "中仙道": "1016005",
    "箕島": "3726288",
    "野田": "1015965",
    "岡山ネオポリス": "1015767",
    "東岡山": "8001877",
    "柳川セントラル": "1015833",
    "水島インター": "1016039",
    "西大寺金岡": "1015783",
    "神崎": "1015791",
    "田井ポート": "1015957",
    "総社": "8002974",
    "藤田": "1016047",
    "吉備路": "1015841",
    "西大寺": "8002594",
    "富田": "1015973",
    "中筋": "8104622",
    "新涯": "1016153",
    "焼山": "1016229",
    "西条中央": "1016252",
    "鴨方インター": "1016278",
    "新伊勢丘": "3726304",
    "中央": "8103657",
    "矢野": "8103152",
    "亀山": "8103293",
    "安佐北": "8104481",
    "せとうち尾道": "1016179",
    "早島インター": "1015858",
    "黒瀬": "1016203",
    "周南": "7015944",
    "吉見園": "7019664",
    "沼田": "7020480"
};

// チャートのインスタンス
let monthlyTrendChart = null;
let channelRatioChart = null;

// パスワード設定（実際には環境に合わせて変更、または認証で管理）
const GATE_PASSWORD_HASH = "451a17d4e46ee9348c0ad3623bc1fc21ac29d8cc12478af20d32957162edf810"; // "eneos2026" の SHA-256
// ※パスワードのプレーンテキストは「eneos2026」

// 2. 初期化と認証ゲート処理

// ページロード時の初期化
window.addEventListener('DOMContentLoaded', async () => {
    // 0. タブシステムの初期設定とイベント登録
    initTabSystem();

    // 1. 共通パスワード認証の確認
    const storedGateAuth = localStorage.getItem('gate_authenticated');
    if (storedGateAuth === 'true') {
        document.getElementById('auth-gate').style.display = 'none';
        await initSupabase();
    } else {
        document.getElementById('auth-gate').style.display = 'flex';
    }
    
    // 2. 入庫予約CSVのドラッグ＆ドロップイベントの初期化
    initNyukoDragAndDrop();
    
    // 3. 表示期間フィルターの初期値設定 (直近6ヶ月: 5ヶ月前から当月まで)
    const startYearSel = document.getElementById('filter-start-year');
    const startMonthSel = document.getElementById('filter-start-month');
    const endYearSel = document.getElementById('filter-end-year');
    const endMonthSel = document.getElementById('filter-end-month');
    
    if (startYearSel && startMonthSel && endYearSel && endMonthSel) {
        const now = new Date();
        const curY = now.getFullYear();
        const curM = now.getMonth(); // 0-indexed
        
        // 終了月: 今月
        endYearSel.value = String(curY);
        endMonthSel.value = String(curM + 1).padStart(2, '0');
        
        // 開始月: 6ヶ月前 (5ヶ月前の1日)
        const start = new Date(curY, curM - 5, 1);
        startYearSel.value = String(start.getFullYear());
        startMonthSel.value = String(start.getMonth() + 1).padStart(2, '0');
    }
});

// SHA-256ハッシュ化関数（ブラウザ標準API）
async function sha256(message) {
    if (!message) return "";
    
    // 💡 非セキュアコンテキスト（file:// プロトコル等で直接開いた場合）のフォールバック
    if (!window.crypto || !window.crypto.subtle) {
        // 暗号化APIが使えない環境でも、入力値が正しければ一致ハッシュを直接返してログインを許可します
        if (String(message).trim() === "eneos2026") {
            return "451a17d4e46ee9348c0ad3623bc1fc21ac29d8cc12478af20d32957162edf810";
        }
        return "fallback_incorrect_hash";
    }

    const msgBuffer = new TextEncoder().encode(String(message).trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// UUIDの生成関数 (crypto.randomUUID が使えない環境へのフォールバック付き)
function generateUUID() {
    if (window.crypto && window.crypto.randomUUID) {
        return window.crypto.randomUUID();
    }
    // Math.random を用いた RFC4122 v4 準拠フォールバック
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}


// あいまい店舗名マッチングのクリーンアップヘルパー
function cleanStr(str) {
    return String(str).toLowerCase()
        .replace(/[\s　]+/g, '')          // スペース除去
        .replace(/セルフ/g, '')           // 「セルフ」除去
        .replace(/dr\.drive|dr\-|dd/g, '') // 「Dr.Drive」「DD」など除去
        .replace(/店$/g, '');             // 末尾の「店」除去
}

// インポートログ用コンソール出力関数
function logToConsole(message, type = 'haishin') {
    const consoleId = type === 'haishin' ? 'import-console' : 'nyuko-import-console';
    const consoleEl = document.getElementById(consoleId);
    if (consoleEl) {
        // 初期プレースホルダーをクリア
        if (consoleEl.innerText.includes("コンソール待機") || consoleEl.innerText.includes("CSVドロップ") || consoleEl.innerText.includes("左側のエリア")) {
            consoleEl.innerText = "";
        }
        consoleEl.innerText += message + "\n";
        consoleEl.scrollTop = consoleEl.scrollHeight; // 自動スクロール
    }
    console.log(`[${type}] ${message}`);
}

// 共通パスワード認証の実行
async function handleGateAuth(e) {
    e.preventDefault();
    const password = document.getElementById('gate-password').value;
    const hash = await sha256(password);
    
    if (hash === GATE_PASSWORD_HASH) {
        localStorage.setItem('gate_authenticated', 'true');
        document.getElementById('gate-error').style.display = 'none';
        document.getElementById('auth-gate').style.display = 'none';
        showToast("🔓 認証に成功しました。", "success");
        await initSupabase();
    } else {
        document.getElementById('gate-error').style.display = 'block';
        showToast("❌ パスワードが違います。", "error");
    }
}

// Supabase設定が未完了、または接続エラー時のハンドリング
function handleSetupRequired() {
    storesCache = [];
    campaignsCache = [];
    smsDeliveriesCache = [];
    reservationsCache = [];
    storeOwnSmsCache = [];
    categoryMappingsCache = [];

    // UIを空にする
    buildFilterSelectors();
    renderCampaignGrid();
    try {
        loadAllData();
    } catch (e) {
        console.error(e);
    }

    // 接続設定モーダルを開く
    openSetupModal();
}

// Supabaseクライアントの初期化
async function initSupabase() {
    // ローカルテスト用に仮の環境変数を設定。実際にはデプロイ時に書き換えます。
    // クライアント側には anonキー（読み取り専用権限）を設定します。
    const SUPABASE_URL = window.localStorage.getItem('SUPABASE_URL') || "https://your-project.supabase.co";
    const SUPABASE_ANON_KEY = window.localStorage.getItem('SUPABASE_ANON_KEY') || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";

    if (SUPABASE_URL === "https://your-project.supabase.co" || !window.localStorage.getItem('SUPABASE_URL')) {
        console.log("Supabase未設定のため、接続設定を促します。");
        showToast("⚙️ 最初にSupabaseの接続設定を行ってください。", "info");
        handleSetupRequired();
        return;
    }

    try {
        // 💡 HTTPキャッシュによる古いデータの読み込み（反映ラグや表示不一致）を防ぐため、
        // すべてのAPIリクエストにキャッシュ無効化ヘッダーを強制付与します。
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: {
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            }
        });
        
        // 管理者のログイン状態をチェック
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            setAdminMode(true);
        }

        // 初期データのロード
        await loadInitialData();
    } catch (err) {
        console.error("Supabase接続エラー:", err);
        showToast("⚠️ データベースへの接続に失敗しました。接続設定を確認してください。", "error");
        handleSetupRequired();
    }
}

// 管理者セッションが有効かどうかをチェックするヘルパー関数
async function checkAdminSession() {
    // 💡 自動テスト検証用の擬似セッション切れフック
    if (window.__testSessionExpired) {
        showToast("⚠️ セッションの有効期限が切れました。再度ログインしてください。", "warning");
        logToConsole("⚠️ エラー: 管理者セッションが無効です。再ログインが必要です。");
        openAdminModal(); // 自動的に管理者ログイン画面を表示
        return false;
    }
    if (!supabaseClient) return true; // オフラインデモ時は常にスルー
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session) {
            showToast("⚠️ セッションの有効期限が切れました。再度ログインしてください。", "warning");
            logToConsole("⚠️ エラー: 管理者セッションが無効です。再ログインが必要です。");
            openAdminModal(); // 💡 自動的に管理者ログイン画面を表示
            return false;
        }
        return true;
    } catch (e) {
        console.error("セッションチェックエラー:", e);
        return false;
    }
}

// 設定が未完了である場合のローカル仮設定UI
function showSetupRequiredMessage() {
    handleSetupRequired();
}

// 3. 管理者ログイン認証

function openAdminModal() {
    document.getElementById('admin-modal').style.display = 'flex';
}

function closeAdminModal() {
    document.getElementById('admin-modal').style.display = 'none';
}

// 接続設定モーダルの開閉
function openSetupModal() {
    const storedUrl = window.localStorage.getItem('SUPABASE_URL') || "";
    const storedKey = window.localStorage.getItem('SUPABASE_ANON_KEY') || "";
    
    document.getElementById('setup-url').value = storedUrl === "https://your-project.supabase.co" ? "" : storedUrl;
    document.getElementById('setup-anon-key').value = storedKey.startsWith("eyJhbGciOi") ? storedKey : "";
    
    document.getElementById('setup-modal').style.display = 'flex';
}

function closeSetupModal() {
    document.getElementById('setup-modal').style.display = 'none';
}

// 接続設定の保存・適用
async function handleSaveSetup(e) {
    e.preventDefault();
    const url = document.getElementById('setup-url').value.trim();
    const key = document.getElementById('setup-anon-key').value.trim();
    
    if (!url || !key) {
        showToast("❌ URLとAnon Keyを正しく入力してください。", "error");
        return;
    }
    
    window.localStorage.setItem('SUPABASE_URL', url);
    window.localStorage.setItem('SUPABASE_ANON_KEY', key);
    
    closeSetupModal();
    showToast("💾 接続設定を保存しました。再接続します...", "success");
    
    // 即時再初期化を試みる
    await initSupabase();
}

// 接続設定のクリア（デモモードに戻す）
function handleClearSetup() {
    window.localStorage.removeItem('SUPABASE_URL');
    window.localStorage.removeItem('SUPABASE_ANON_KEY');
    
    closeSetupModal();
    showToast("🧹 設定をクリアし、デモモードに戻しました。", "info");
    
    // 即時再初期化（デモモードへの切り替え）
    initSupabase();
}

// 管理者ログイン処理 (Supabase Auth)
async function handleAdminLogin(e) {
    e.preventDefault();
    const email = document.getElementById('admin-email').value;
    const password = document.getElementById('admin-password').value;
    
    // 💡 自動テスト検証用の擬似ログイン成功バイパスフック
    if (window.__bypassAuth) {
        setAdminMode(true);
        closeAdminModal();
        showToast("🔑 管理者ログインに成功しました。", "success");
        await loadInitialData();

        // 💡 ログイン成功に伴う、保留中CSVの自動アップロード再開処理
        if (pendingUploadFile && pendingUploadCampaignId) {
            logToConsole("🚀 再ログインに成功したため、保留されていたCSVインポートを自動再開します...");
            const file = pendingUploadFile;
            const campaignId = pendingUploadCampaignId;
            
            // 二重実行防止のために変数をクリア
            pendingUploadFile = null;
            pendingUploadCampaignId = null;
            
            // アップロードを自動再開
            await processGridFile(file, campaignId);
        }
        return;
    }
    
    if (!supabaseClient) {
        // オフライン・ダミーデータ動作の場合の簡易管理者ログイン
        if (email === "admin@example.com" && password === "admin2026") {
            setAdminMode(true);
            closeAdminModal();
            showToast("🔑 管理者モード（オフラインデモ）でログインしました。", "success");
            return;
        }
        document.getElementById('admin-error').style.display = 'block';
        return;
    }

    try {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        setAdminMode(true);
        closeAdminModal();
        showToast("🔑 管理者ログインに成功しました。", "success");
        await loadInitialData();

        // 💡 ログイン成功に伴う、保留中CSVの自動アップロード再開処理
        if (pendingUploadFile && pendingUploadCampaignId) {
            logToConsole("🚀 再ログインに成功したため、保留されていたCSVインポートを自動再開します...");
            const file = pendingUploadFile;
            const campaignId = pendingUploadCampaignId;
            
            // 二重実行防止のために変数をクリア
            pendingUploadFile = null;
            pendingUploadCampaignId = null;
            
            // アップロードを自動再開
            await processGridFile(file, campaignId);
        }
    } catch (err) {
        console.error(err);
        document.getElementById('admin-error').style.display = 'block';
        showToast("❌ ログインに失敗しました。", "error");
    }
}

// 管理者ログアウト処理
async function handleAdminLogout() {
    if (supabaseClient) {
        await supabaseClient.auth.signOut();
    }
    setAdminMode(false);
    
    // 💡 ログアウト時にキャッシュメモリを完全にリセットし、ゴースト表示を防ぐ
    storesCache = [];
    campaignsCache = [];
    smsDeliveriesCache = [];
    reservationsCache = [];
    storeOwnSmsCache = [];
    categoryMappingsCache = [];
    
    showToast("🔒 ログアウトしました。", "success");
    switchTab('dashboard-view');
    
    // キャッシュ無効化されたクリーンな初期状態を再ロード
    await loadInitialData();
}

// 管理者UI表示の切り替え
function setAdminMode(active) {
    isAdmin = active;
    const adminElements = document.querySelectorAll('.admin-only');
    adminElements.forEach(el => {
        el.style.display = active ? 'block' : 'none';
    });

    if (active) {
        document.getElementById('admin-login-btn').style.display = 'none';
        document.getElementById('admin-status-container').style.display = 'flex';
    } else {
        document.getElementById('admin-login-btn').style.display = 'block';
        document.getElementById('admin-status-container').style.display = 'none';
    }
}

// 4. データ読み込み処理 (Supabase からロード)

async function loadInitialData(skipDeliveries = false) {
    if (!supabaseClient) return;
    
    // 💡 複数セッション（ログイン・ログアウトの重複やHMR等）の競合によるキャッシュ上書きを防ぐロック
    if (isDataLoading) {
        console.log("⚠️ loadInitialData がすでに処理中のため、重複呼び出しを無視します。");
        return;
    }
    isDataLoading = true;

    try {
        // 💡 ブラウザが file:// や localhost 環境で API レスポンスを強制キャッシュし、
        // データの不整合を起こすのを防ぐため、全クエリに動的UUIDによるキャッシュ破壊フィルタを適用
        
        // 店舗マスタのロード
        const { data: stores, error: err1 } = await supabaseClient
            .from('stores')
            .select('*')
            .neq('store_code', 'dummy_' + generateUUID())
            .order('store_name');
        if (err1) throw err1;
        storesCache = stores;

        // 配信キャンペーンのロード
        const { data: campaigns, error: errCamp } = await supabaseClient
            .from('campaigns')
            .select('*')
            .neq('id', generateUUID())
            .order('delivery_date', { ascending: false });
        if (errCamp) throw errCamp;
        campaignsCache = campaigns;
        initializeDrawMonths();

        // 配信実績のロード (ランダムUUIDでキャッシュを完全破壊しつつ、1000件制限をループで回避)
        if (!skipDeliveries) {
            let allDeliveries = [];
            let from = 0;
            const step = 1000;
            let hasMore = true;
            while (hasMore) {
                const { data: deliveries, error: err2 } = await supabaseClient
                    .from('sms_deliveries')
                    .select('*')
                    .neq('id', generateUUID())
                    .range(from, from + step - 1);
                if (err2) throw err2;
                allDeliveries.push(...deliveries);
                if (deliveries.length < step) {
                    hasMore = false;
                } else {
                    from += step;
                }
            }
            smsDeliveriesCache = allDeliveries;
        }

        // 予約実績のロード (1000件制限をループで回避)
        let allReservations = [];
        let fromRes = 0;
        const stepRes = 1000;
        let hasMoreRes = true;
        while (hasMoreRes) {
            const { data: reservations, error: err3 } = await supabaseClient
                .from('reservations')
                .select('*')
                .neq('id', generateUUID())
                .range(fromRes, fromRes + stepRes - 1);
            if (err3) throw err3;
            allReservations.push(...reservations);
            if (reservations.length < stepRes) {
                hasMoreRes = false;
            } else {
                fromRes += stepRes;
            }
        }
        reservationsCache = allReservations;

        // 店舗独自SMSのロード
        const { data: storeSms, error: err4 } = await supabaseClient
            .from('store_own_sms')
            .select('*')
            .neq('id', generateUUID());
        if (err4) throw err4;
        storeOwnSmsCache = storeSms;

        // 集計ルールのロード
        const { data: mappings, error: errMap } = await supabaseClient
            .from('category_mappings')
            .select('*')
            .neq('id', generateUUID());
        if (errMap) throw errMap;
        categoryMappingsCache = mappings;

        // フィルター用セレクトボックスの構築
        buildFilterSelectors();

        // 配信スケジュールグリッドUIの構築
        renderCampaignGrid();

        // データの集計と可視化
        loadAllData();
        
        // 🔍 データベースと実績データの整合性チェック
        await debugPrintDatabaseState();
        
        // 🔍 デバッグ：実際のオイル1およびオイル2の現在のIDに紐づくデータをダンプ
        const realOil1 = campaignsCache.find(c => c.campaign_name && c.campaign_name.includes("オイル1"));
        const realOil2 = campaignsCache.find(c => c.campaign_name && c.campaign_name.includes("オイル2"));
        
        if (realOil1) {
            const oil1Dels = smsDeliveriesCache.filter(d => d.campaign_id === realOil1.id);
            logToConsole(`🔍 [デバッグ] キャッシュ上のオイル1 (${realOil1.campaign_name}) の実績数: ${oil1Dels.length} 件`);
        }
        if (realOil2) {
            const oil2Dels = smsDeliveriesCache.filter(d => d.campaign_id === realOil2.id);
            logToConsole(`🔍 [デバッグ] キャッシュ上のオイル2 (${realOil2.campaign_name}) の実績数: ${oil2Dels.length} 件`);
        }

        showToast("🔄 最新データをロードしました。", "success");
    } catch (err) {
        console.error("データ読み込みエラー:", err);
        showToast("❌ データの読み込みに失敗しました。", "error");
    } finally {
        isDataLoading = false;
    }
}

// 🔍 データベースのキャンペーンと配信実績の紐づきをコンソールに出力するデバッグ関数
async function debugPrintDatabaseState() {
    if (!supabaseClient) return;
    try {
        logToConsole("🔍 データベース（Supabase）内のキャンペーンと実績の紐づきをチェックしています...");
        
        // 1. campaigns から全取得
        const { data: camps, error: errC } = await supabaseClient.from('campaigns').select('id, campaign_name, delivery_date');
        if (errC) throw errC;
        
        // 2. sms_deliveries から全取得 (1000件制限をループで回避)
        let dels = [];
        let fromDel = 0;
        const stepDel = 1000;
        let hasMoreDel = true;
        while (hasMoreDel) {
            const { data: chunkDels, error: errD } = await supabaseClient
                .from('sms_deliveries')
                .select('id, campaign_id, store_code')
                .range(fromDel, fromDel + stepDel - 1);
            if (errD) throw errD;
            dels.push(...chunkDels);
            if (chunkDels.length < stepDel) {
                hasMoreDel = false;
            } else {
                fromDel += stepDel;
            }
        }
        
        if (!camps || !dels) return;
        
        logToConsole(`--- 📋 [デバッグ] DB内の全キャンペーン (${camps.length}件) ---`);
        camps.forEach(c => {
            const count = dels.filter(d => d.campaign_id === c.id).length;
            logToConsole(`  ・[${c.delivery_date}] 名前: ${c.campaign_name} | ID: ${c.id} ➡ 実績数: ${count} 件`);
        });
        
        logToConsole(`--- 📋 [デバッグ] DB内の実績データ (${dels.length}件) のcampaign_id一覧 ---`);
        const counts = {};
        dels.forEach(d => {
            counts[d.campaign_id] = (counts[d.campaign_id] || 0) + 1;
        });
        
        const campIds = new Set(camps.map(c => c.id));
        let orphanCount = 0;
        
        Object.entries(counts).forEach(([id, count]) => {
            const hasCamp = campIds.has(id);
            const campName = hasCamp ? camps.find(c => c.id === id).campaign_name : "⚠️存在しないキャンペーン";
            logToConsole(`  ・ID: ${id} (${campName}) ➡ 件数: ${count} 件`);
            if (!hasCamp) {
                orphanCount += count;
            }
        });
        
        logToConsole(`----------------------------------------------`);
    } catch (err) {
        console.error("デバッグ出力エラー:", err);
        logToConsole(`❌ データベース調査中にエラーが発生しました: ${err.message || err}`);
    }
}

// デモ用ダミーデータの生成 (Supabase環境がない場合の動作確認用) - 完全無効化
function loadDummyData() {
    console.log("loadDummyData has been disabled.");
}

// 年の選択肢を動的に生成するヘルパー関数
// isDashboardFilter = true の場合は過去5年〜将来2年、false の場合は過去2年〜将来2年を基準とし、
// キャッシュ内に存在するすべての年もマージして昇順ソートしたHTML Optionを返す
function getDynamicYearOptions(selectedYear = null, isDashboardFilter = false) {
    const years = new Set();
    const now = new Date();
    const thisYear = now.getFullYear();
    
    // 1. 基準範囲の自動算出 (ダッシュボードフィルターは過去5年、アコーディオン作成は過去2年)
    const pastRange = isDashboardFilter ? 5 : 2;
    const futureRange = 2;
    
    for (let y = thisYear - pastRange; y <= thisYear + futureRange; y++) {
        years.add(y);
    }
    
    // 2. 既存スケジュールデータ(campaignsCache)に登録されている年を追加
    campaignsCache.forEach(c => {
        if (c.delivery_date) {
            const y = parseInt(c.delivery_date.split('-')[0]);
            if (y && !isNaN(y)) {
                years.add(y);
            }
        }
    });

    // 3. 既存店舗独自SMSデータ(storeOwnSmsCache)に登録されている年を追加
    storeOwnSmsCache.forEach(s => {
        if (s.delivery_month) {
            const y = parseInt(s.delivery_month.split('-')[0]);
            if (y && !isNaN(y)) {
                years.add(y);
            }
        }
    });

    // 4. 引数で指定された現在値も追加
    if (selectedYear) {
        const y = parseInt(selectedYear);
        if (y && !isNaN(y)) {
            years.add(y);
        }
    }
    
    // 昇順にソート
    const sortedYears = Array.from(years).sort((a, b) => a - b);
    
    // HTML Option の生成 (selectedYearが指定されない限り、どの年にもselectedを付与せず空欄にします)
    return sortedYears.map(y => {
        const isSelected = (selectedYear && y === parseInt(selectedYear)) ? 'selected' : '';
        return `<option value="${y}" ${isSelected}>${y}年</option>`;
    }).join('');
}

// 表示期間フィルターの年選択肢を動的に設定
function rebuildPeriodYearFilters() {
    const startYearSel = document.getElementById('filter-start-year');
    const endYearSel = document.getElementById('filter-end-year');
    
    if (startYearSel && endYearSel) {
        const startVal = startYearSel.value;
        const endVal = endYearSel.value;
        
        startYearSel.innerHTML = getDynamicYearOptions(startVal, true);
        endYearSel.innerHTML = getDynamicYearOptions(endVal, true);
    }
}

// 5. フィルター構築とイベント処理

function buildFilterSelectors() {
    const areaSelect = document.getElementById('filter-area');
    const storeSelect = document.getElementById('filter-store');

    // 1. エリアリストの作成
    const areas = [...new Set(storesCache.map(s => s.area_name))];
    areaSelect.innerHTML = '<option value="all">全エリア</option>';
    areas.forEach(a => {
        areaSelect.innerHTML += `<option value="${a}">${a}</option>`;
    });

    // 2. 表示期間フィルターの年を動的構築
    rebuildPeriodYearFilters();

    // 3. 店舗リストの作成
    rebuildStoreSelector();
}

function rebuildStoreSelector() {
    const areaSelect = document.getElementById('filter-area');
    const storeSelect = document.getElementById('filter-store');
    const selectedArea = areaSelect.value;

    let filteredStores = storesCache;
    if (selectedArea !== 'all') {
        filteredStores = storesCache.filter(s => s.area_name === selectedArea);
    }

    storeSelect.innerHTML = '<option value="all">全店舗</option>';
    filteredStores.forEach(s => {
        storeSelect.innerHTML += `<option value="${s.store_code}">${s.store_name}</option>`;
    });
}

function handleAreaChange() {
    rebuildStoreSelector();
    loadAllData();
}

function handleLogicToggle() {
    loadAllData();
    showToast("📊 集計ロジックを切り替えました。", "info");
}

// ==========================================================================
// 5. タブ切り替えとナビゲーションの堅牢化リファクタリング
// ==========================================================================

// タブシステムの初期化 (イベントの一元バインド)
function initTabSystem() {
    const tabBtns = document.querySelectorAll('#main-tabs .tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            if (tabId) {
                switchTab(tabId);
            }
        });
    });
    
    // 自己整合性診断を実行
    validateTabElements();
}

// 自己診断テスト (ID不一致の早期検出)
function validateTabElements() {
    console.log("🔍 [TabSystem] 自己整合性テストを開始中...");
    const tabBtns = document.querySelectorAll('#main-tabs .tab-btn');
    let errorCount = 0;
    
    tabBtns.forEach(btn => {
        const tabId = btn.getAttribute('data-tab');
        if (!tabId) {
            console.error("❌ [TabSystem Error] タブボタンに data-tab 属性がありません！", btn);
            errorCount++;
            return;
        }
        const contentEl = document.getElementById(tabId);
        if (!contentEl) {
            console.error(`❌ [TabSystem Error] タブボタンが指定するコンテンツID「${tabId}」に対応する .tab-content 要素がHTML内に存在しません！`);
            errorCount++;
        } else if (!contentEl.classList.contains('tab-content')) {
            console.warn(`⚠️ [TabSystem Warning] 要素「${tabId}」は存在しますが、.tab-content クラスが付与されていません。`);
        }
    });
    
    if (errorCount === 0) {
        console.log("✅ [TabSystem] 自己整合性テストをパスしました。すべてのタブIDは正常です。");
    } else {
        console.error(`🚨 [TabSystem] テスト失敗: ${errorCount} 件の不整合を検出しました。HTML/JS構造を確認してください。`);
    }
}

// 堅牢化したTab切り替え
function switchTab(tabId) {
    const targetEl = document.getElementById(tabId);
    if (!targetEl) {
        console.error(`🚨 [TabSystem] 指定されたタブID「${tabId}」が存在しないため、ダッシュボードへ自動フォールバックします。`);
        if (tabId !== 'dashboard-view') {
            switchTab('dashboard-view');
        }
        return;
    }
    
    // 管理者専用タブへの未ログイン状態での侵入ガード
    const tabBtn = document.querySelector(`#main-tabs .tab-btn[data-tab="${tabId}"]`);
    const isBtnAdminOnly = tabBtn ? tabBtn.classList.contains('admin-only') : false;
    if (isBtnAdminOnly && !isAdmin) {
        console.warn(`🚨 [TabSystem] 管理者未ログイン状態で専用タブ「${tabId}」への遷移を検出したため、ダッシュボードへ差し戻します。`);
        if (tabId !== 'dashboard-view') {
            switchTab('dashboard-view');
        }
        return;
    }

    currentTab = tabId;
    
    // フィルターバーの表示・非表示制御
    const filterBar = document.getElementById('global-filter-bar');
    if (filterBar) {
        if (tabId === 'dashboard-view' || tabId === 'store-view') {
            filterBar.style.display = 'block';
        } else {
            filterBar.style.display = 'none';
        }
    }

    // タブボタンのアクティブ状態の更新 (data-tab基準)
    const tabBtns = document.querySelectorAll('#main-tabs .tab-btn');
    tabBtns.forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tab') === tabId) {
            btn.classList.add('active');
        }
    });

    // コンテンツ表示の切り替え
    const contents = document.querySelectorAll('.tab-content');
    contents.forEach(content => {
        content.classList.remove('active');
    });
    targetEl.classList.add('active');

    // タブ切り替え時のデータロード・描画処理
    if (tabId === 'sms-manage-view') {
        loadStoreSmsGrid();
        renderCampaignGrid();
    } else if (tabId === 'reservation-manage-view') {
        loadReservationsList();
    } else if (tabId === 'system-setting-view') {
        loadStoresMaster();
        renderMappingRules();
    } else {
        loadAllData();
    }
}

// 6. コア集計エンジンの実装 (単純・突合の切り替え)

function loadAllData() {
    const area = document.getElementById('filter-area').value;
    const store = document.getElementById('filter-store').value;
    const category = document.getElementById('filter-category').value;
    
    // 年と月を結合して YYYY-MM を作る
    const startYear = document.getElementById('filter-start-year')?.value;
    const startMonthVal = document.getElementById('filter-start-month')?.value;
    const endYear = document.getElementById('filter-end-year')?.value;
    const endMonthVal = document.getElementById('filter-end-month')?.value;
    
    const startMonth = (startYear && startMonthVal) ? `${startYear}-${startMonthVal}` : null;
    const endMonth = (endYear && endMonthVal) ? `${endYear}-${endMonthVal}` : null;
    
    const isIdMatchMode = document.getElementById('logic-toggle').checked;

    // 1. 店舗の絞り込み
    let targetStoreCodes = storesCache;
    if (area !== 'all') targetStoreCodes = targetStoreCodes.filter(s => s.area_name === area);
    if (store !== 'all') targetStoreCodes = targetStoreCodes.filter(s => s.store_code === store);
    const targetStoreCodesList = targetStoreCodes.map(s => s.store_code);

    // 配信データとキャンペーン親レコードを結合（配信日やカテゴリの取得用）
    const joinedDeliveries = smsDeliveriesCache.map(d => {
        const camp = campaignsCache.find(c => c.id === d.campaign_id);
        return {
            ...d,
            delivery_date: camp ? camp.delivery_date : 'unknown',
            category: camp ? camp.category : 'unknown',
            campaign_name: camp ? camp.campaign_name : 'unknown'
        };
    });

    // 2. 配信データ絞り込み
    let filteredDeliveries = joinedDeliveries.filter(d => targetStoreCodesList.includes(d.store_code));
    if (category !== 'all') filteredDeliveries = filteredDeliveries.filter(d => d.category === category);
    if (startMonth) {
        filteredDeliveries = filteredDeliveries.filter(d => d.delivery_date && d.delivery_date.substring(0, 7) >= startMonth);
    }
    if (endMonth) {
        filteredDeliveries = filteredDeliveries.filter(d => d.delivery_date && d.delivery_date.substring(0, 7) <= endMonth);
    }

    // 3. 予約データ絞り込み
    let filteredReservations = reservationsCache.filter(r => targetStoreCodesList.includes(r.store_code));
    // 予約ステータスが本予約または予約確認済みのものを「確定した予約」とする
    filteredReservations = filteredReservations.filter(r => r.status === '本予約' || r.status === '予約確認済み');
    if (startMonth) {
        filteredReservations = filteredReservations.filter(r => r.reception_date && r.reception_date.substring(0, 7) >= startMonth);
    }
    if (endMonth) {
        filteredReservations = filteredReservations.filter(r => r.reception_date && r.reception_date.substring(0, 7) <= endMonth);
    }

    // 4. 店舗独自SMS絞り込み
    let filteredStoreSms = storeOwnSmsCache.filter(s => targetStoreCodesList.includes(s.store_code));
    if (category !== 'all') filteredStoreSms = filteredStoreSms.filter(s => s.category === category);
    if (startMonth) {
        filteredStoreSms = filteredStoreSms.filter(s => s.delivery_month && s.delivery_month >= startMonth);
    }
    if (endMonth) {
        filteredStoreSms = filteredStoreSms.filter(s => s.delivery_month && s.delivery_month <= endMonth);
    }

    // 集計の実行
    let totalSmsSent = 0; // 本部送信宛先数
    let totalSmsVolume = 0; // 本部送信通数
    let totalStoreSms = 0; // 店舗独自SMS数 (件)
    let totalReservations = 0; // 獲得予約数
    
    let smsResCount = 0;
    let lineResCount = 0;
    let emoResCount = 0;

    // 配信日程リスト
    const deliveryDates = [...new Set(filteredDeliveries.map(d => d.delivery_date))].sort();

    // 配信日単位の実績データ格納用
    const deliveryReportData = [];

    // 配信数計算
    totalSmsSent = filteredDeliveries.length; // 宛先数(顧客数)
    filteredDeliveries.forEach(d => totalSmsVolume += (d.sms_count || 1)); // コスト計算用通数
    filteredStoreSms.forEach(s => totalStoreSms += s.sms_count);

    if (isIdMatchMode) {
        // --- A. 顧客ID（不可逆ハッシュ）突合集計ロジック ---
        
        // 配信データのハッシュIDセット（店舗・カテゴリ・配信日ごとに整理）
        // 突合を正確に行うため、配信日ごとにループ処理
        deliveryDates.forEach((delDate, idx) => {
            const nextDelDate = deliveryDates[idx + 1] ? new Date(deliveryDates[idx + 1]) : null;
            const curDelDate = new Date(delDate);
            
            // 配信日に紐づく配信データ
            const dayDeliveries = filteredDeliveries.filter(d => d.delivery_date === delDate);
            const dayCategories = [...new Set(dayDeliveries.map(d => d.category))];
            
            dayCategories.forEach(cat => {
                const catDeliveries = dayDeliveries.filter(d => d.category === cat);
                const deliveryHashes = new Set(catDeliveries.map(d => d.hashed_customer_id));
                const smsCount = catDeliveries.length; // 送信宛先数(顧客数)

                // 店舗独自SMS (該当月、該当カテゴリ)
                const delMonth = delDate.substring(0, 7);
                const catStoreSms = filteredStoreSms
                    .filter(s => s.delivery_month === delMonth && s.category === cat)
                    .reduce((sum, s) => sum + s.sms_count, 0);

                // 集計マッピングルールから、現在のカテゴリ(cat)に許可された予約グループを動的に取得
                const allowedGroups = categoryMappingsCache
                    .filter(m => m.category === cat)
                    .map(m => m.work_group);
                if (allowedGroups.length === 0) allowedGroups.push(cat); // ルール無しの場合は自身

                // 突合期間内 (送信日 〜 次回送信日の前日) の予約を検出
                const matchedReservations = filteredReservations.filter(res => {
                    const resDate = new Date(res.reception_date);
                    // 期間内チェック
                    const isAfterDel = resDate >= curDelDate;
                    const isBeforeNext = nextDelDate ? resDate < nextDelDate : true;
                    
                    // 集計ルールに基づいたカテゴリ一致チェック
                    let isCategoryMatch = false;
                    if (res.work_group) {
                        isCategoryMatch = allowedGroups.some(g => res.work_group.includes(g));
                    }

                    // ハッシュの一致チェック
                    const isHashMatch = deliveryHashes.has(res.hashed_customer_id);

                    return isAfterDel && isBeforeNext && isCategoryMatch && isHashMatch;
                });

                const daySmsRes = matchedReservations.filter(r => r.route === 'SMS予約').length;
                const dayLineRes = matchedReservations.filter(r => r.route === 'LINE予約').length;
                const dayEmoRes = matchedReservations.filter(r => r.route_store === 'EMO_WEB').length;

                // 全体集計へ加算
                smsResCount += daySmsRes;
                lineResCount += dayLineRes;
                emoResCount += dayEmoRes;
                totalReservations += matchedReservations.length;

                deliveryReportData.push({
                    delivery_date: delDate,
                    category: cat,
                    sms_sent: smsCount,
                    store_sms: catStoreSms,
                    sms_res: daySmsRes,
                    line_res: dayLineRes,
                    emo_res: dayEmoRes,
                    total_res: matchedReservations.length
                });
            });
        });

    } else {
        // --- B. 単純経路カウント集計ロジック（従来仕様） ---
        
        // 予約データの単純分類
        filteredReservations.forEach(res => {
            // カテゴリフィルターがある場合、マッピングルールに基づいて絞り込み
            if (category !== 'all') {
                const allowedGroups = categoryMappingsCache
                    .filter(m => m.category === category)
                    .map(m => m.work_group);
                if (allowedGroups.length === 0) allowedGroups.push(category);

                let matchesFilter = false;
                if (res.work_group) {
                    matchesFilter = allowedGroups.some(g => res.work_group.includes(g));
                }
                if (!matchesFilter) return;
            }

            if (res.route === 'SMS予約') {
                smsResCount++;
                totalReservations++;
            } else if (res.route === 'LINE予約') {
                lineResCount++;
                totalReservations++;
            } else if (res.route_store === 'EMO_WEB') {
                emoResCount++;
                totalReservations++;
            }
        });

        // 配信スケジュール（回別）への単純マッピング
        deliveryDates.forEach((delDate, idx) => {
            const nextDelDate = deliveryDates[idx + 1] ? new Date(deliveryDates[idx + 1]) : null;
            const curDelDate = new Date(delDate);

            // 配信日に紐づく配信データ
            const dayDeliveries = filteredDeliveries.filter(d => d.delivery_date === delDate);
            const dayCategories = [...new Set(dayDeliveries.map(d => d.category))];

            dayCategories.forEach(cat => {
                const catDeliveries = dayDeliveries.filter(d => d.category === cat);
                const smsCount = catDeliveries.length; // 送信宛先数(顧客数)

                // 店舗独自SMS
                const delMonth = delDate.substring(0, 7);
                const catStoreSms = filteredStoreSms
                    .filter(s => s.delivery_month === delMonth && s.category === cat)
                    .reduce((sum, s) => sum + s.sms_count, 0);

                // 集計マッピングルールから、現在のカテゴリ(cat)に許可された予約グループを動的に取得
                const allowedGroups = categoryMappingsCache
                    .filter(m => m.category === cat)
                    .map(m => m.work_group);
                if (allowedGroups.length === 0) allowedGroups.push(cat);

                // 単純集計：期間内の全経路予約数を集計
                const dayReservations = filteredReservations.filter(res => {
                    const resDate = new Date(res.reception_date);
                    const isAfterDel = resDate >= curDelDate;
                    const isBeforeNext = nextDelDate ? resDate < nextDelDate : true;
                    
                    let isCategoryMatch = false;
                    if (res.work_group) {
                        isCategoryMatch = allowedGroups.some(g => res.work_group.includes(g));
                    }
                    return isAfterDel && isBeforeNext && isCategoryMatch;
                });

                const daySmsRes = dayReservations.filter(r => r.route === 'SMS予約').length;
                const dayLineRes = dayReservations.filter(r => r.route === 'LINE予約').length;
                const dayEmoRes = dayReservations.filter(r => r.route_store === 'EMO_WEB').length;

                deliveryReportData.push({
                    delivery_date: delDate,
                    category: cat,
                    sms_sent: smsCount,
                    store_sms: catStoreSms,
                    sms_res: daySmsRes,
                    line_res: dayLineRes,
                    emo_res: dayEmoRes,
                    total_res: daySmsRes + dayLineRes + dayEmoRes
                });
            });
        });
    }

    // KPIカードの表示更新
    const totalSmsDenom = totalSmsSent + totalStoreSms;
    const bookingRate = totalSmsDenom > 0 ? (totalReservations / totalSmsDenom * 100).toFixed(2) : "0.00";

    document.getElementById('kpi-sms-sent').innerText = totalSmsDenom.toLocaleString() + " 件";
    document.getElementById('kpi-sms-meta').innerText = `本部宛先: ${totalSmsSent.toLocaleString()} 件 (通数: ${totalSmsVolume.toLocaleString()} 通) / 店舗独自: ${totalStoreSms.toLocaleString()} 件`;

    document.getElementById('kpi-reservations').innerText = totalReservations.toLocaleString() + " 件";
    document.getElementById('kpi-reservations-meta').innerText = `SMS予約: ${smsResCount} / LINE予約: ${lineResCount} / EMo: ${emoResCount}`;

    document.getElementById('kpi-rate').innerText = bookingRate + " %";
    document.getElementById('kpi-rate-meta').innerText = isIdMatchMode ? "※ハッシュ突合による予約率" : "※単純経路カウントによる予約率";

    // グラフの描画更新
    renderCharts(deliveryReportData, smsResCount, lineResCount, emoResCount);

    // 実績テーブルの更新
    renderDeliveryTable(deliveryReportData);

    // 店舗ヒートマップの更新 (Tab 2 がアクティブの場合のみ、あるいは常に裏で更新)
    renderStoreHeatmap(targetStoreCodes, joinedDeliveries, filteredReservations, filteredStoreSms, isIdMatchMode, category);
}

// 7. 可視化・グラフィックス処理 (Chart.js / テーブル)

function renderCharts(reportData, sms, line, emo) {
    // 1. 月次推移グラフの処理
    const monthlyData = {};
    reportData.forEach(item => {
        const month = item.delivery_date.substring(0, 7);
        if (!monthlyData[month]) {
            monthlyData[month] = { sent: 0, res: 0 };
        }
        monthlyData[month].sent += (item.sms_sent + item.store_sms);
        monthlyData[month].res += item.total_res;
    });

    const months = Object.keys(monthlyData).sort();
    const sentCounts = months.map(m => monthlyData[m].sent);
    const resCounts = months.map(m => monthlyData[m].res);
    const rates = months.map(m => monthlyData[m].sent > 0 ? (monthlyData[m].res / monthlyData[m].sent * 100).toFixed(1) : 0);

    if (monthlyTrendChart) monthlyTrendChart.destroy();
    
    const ctx1 = document.getElementById('monthly-trend-chart').getContext('2d');
    monthlyTrendChart = new Chart(ctx1, {
        type: 'line',
        data: {
            labels: months,
            datasets: [
                {
                    label: '予約率 (%)',
                    data: rates,
                    type: 'line',
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    borderWidth: 3,
                    yAxisID: 'y-rate',
                    tension: 0.3,
                    fill: true
                },
                {
                    label: '送信数 (件)',
                    data: sentCounts,
                    type: 'bar',
                    backgroundColor: 'rgba(59, 130, 246, 0.5)',
                    borderColor: '#3b82f6',
                    borderWidth: 1,
                    yAxisID: 'y-sent'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#f8fafc' } }
            },
            scales: {
                x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8' } },
                'y-rate': {
                    type: 'linear',
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: { color: '#10b981', callback: val => val + '%' },
                    title: { display: true, text: '予約率 (%)', color: '#10b981' }
                },
                'y-sent': {
                    type: 'linear',
                    position: 'left',
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#3b82f6' },
                    title: { display: true, text: '送信数 (件)', color: '#3b82f6' }
                }
            }
        }
    });

    // 2. 予約チャネル割合グラフの処理
    if (channelRatioChart) channelRatioChart.destroy();
    
    const ctx2 = document.getElementById('channel-ratio-chart').getContext('2d');
    channelRatioChart = new Chart(ctx2, {
        type: 'doughnut',
        data: {
            labels: ['SMS予約', 'LINE予約', 'EMo予約'],
            datasets: [{
                data: [sms, line, emo],
                backgroundColor: [
                    '#3b82f6', // Blue
                    '#f59e0b', // Amber
                    '#10b981'  // Emerald
                ],
                borderWidth: 2,
                borderColor: '#1e293b'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#f8fafc', padding: 20 }
                }
            }
        }
    });
}

function renderDeliveryTable(reportData) {
    const tableBody = document.querySelector('#delivery-table tbody');
    if (reportData.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">該当する実績データがありません。</td></tr>';
        return;
    }

    tableBody.innerHTML = '';
    reportData.forEach(item => {
        const totalSent = item.sms_sent + item.store_sms;
        const rate = totalSent > 0 ? (item.total_res / totalSent * 100).toFixed(2) : "0.00";
        
        tableBody.innerHTML += `
            <tr>
                <td style="font-weight: 600;">${item.delivery_date}</td>
                <td><span style="padding: 2px 8px; border-radius: 12px; background: rgba(59, 130, 246, 0.15); color: #93c5fd; font-size: 11px;">${item.category}</span></td>
                <td>${item.sms_sent.toLocaleString()} 件</td>
                <td>${item.store_sms.toLocaleString()} 件</td>
                <td>${item.sms_res} 件</td>
                <td>${item.line_res} 件</td>
                <td>${item.emo_res} 件</td>
                <td style="font-weight: 700; color: var(--secondary);">${rate} %</td>
            </tr>
        `;
    });
}

function renderStoreHeatmap(stores, deliveries, reservations, storeSms, isIdMatchMode, filterCategory) {
    const tableBody = document.querySelector('#store-heatmap-table tbody');
    tableBody.innerHTML = '';

    stores.forEach(store => {
        const sDeliveries = deliveries.filter(d => d.store_code === store.store_code);
        const sReservations = reservations.filter(r => r.store_code === store.store_code);
        const sStoreSms = storeSms.filter(s => s.store_code === store.store_code);

        let smsSent = sDeliveries.length; // 送信宛先数(顧客数)
        let ownSms = sStoreSms.reduce((sum, s) => sum + s.sms_count, 0);

        let smsRes = 0;
        let lineRes = 0;
        let emoRes = 0;

        if (isIdMatchMode) {
            // ID突合
            const deliveryHashes = new Set(sDeliveries.map(d => d.hashed_customer_id));
            const matchedRes = sReservations.filter(res => {
                const isHashMatch = deliveryHashes.has(res.hashed_customer_id);
                
                let isCatMatch = filterCategory === 'all';
                if (!isCatMatch && res.work_group) {
                    if (filterCategory === 'コーティング') {
                        isCatMatch = res.work_group.includes('コーティング') || res.work_group.includes('洗車');
                    } else {
                        isCatMatch = res.work_group.includes(filterCategory);
                    }
                }
                return isHashMatch && isCatMatch;
            });
            
            smsRes = matchedRes.filter(r => r.route === 'SMS予約').length;
            lineRes = matchedRes.filter(r => r.route === 'LINE予約').length;
            emoRes = matchedRes.filter(r => r.route_store === 'EMO_WEB').length;
        } else {
            // 単純カウント
            const targetRes = sReservations.filter(res => {
                let matchesFilter = filterCategory === 'all';
                if (!matchesFilter && res.work_group) {
                    if (filterCategory === 'コーティング') {
                        matchesFilter = res.work_group.includes('コーティング') || res.work_group.includes('洗車');
                    } else {
                        matchesFilter = res.work_group.includes(filterCategory);
                    }
                }
                return matchesFilter;
            });

            smsRes = targetRes.filter(r => r.route === 'SMS予約').length;
            lineRes = targetRes.filter(r => r.route === 'LINE予約').length;
            emoRes = targetRes.filter(r => r.route_store === 'EMO_WEB').length;
        }

        const totalRes = smsRes + lineRes + emoRes;
        const totalSent = smsSent + ownSms;
        const rateVal = totalSent > 0 ? (totalRes / totalSent * 100) : 0;

        // ヒートマップレベルの判定
        let hmClass = 'hm-level-0';
        if (rateVal >= 4.0) hmClass = 'hm-level-3';
        else if (rateVal >= 2.5) hmClass = 'hm-level-2';
        else if (rateVal >= 1.0) hmClass = 'hm-level-1';

        tableBody.innerHTML += `
            <tr>
                <td style="font-weight: 600;">${store.store_name}</td>
                <td><span style="color: var(--text-muted); font-size: 12px;">${store.area_name}</span></td>
                <td>${smsSent.toLocaleString()}</td>
                <td>${ownSms.toLocaleString()}</td>
                <td>${smsRes}</td>
                <td>${lineRes}</td>
                <td>${emoRes}</td>
                <td class="hm-cell ${hmClass}">${rateVal.toFixed(2)} %</td>
            </tr>
        `;
    });
}

function handleImportTypeChange() {
    const importType = document.getElementById('import-type').value;
    const haishinOptions = document.getElementById('haishin-options');
    
    if (importType === 'haishin') {
        haishinOptions.style.display = 'flex';
    } else {
        haishinOptions.style.display = 'none';
    }
}

// 行ごとのPII除去・不可逆ハッシュ化・バリデーション処理
async function processAndUploadRows(rows, fieldnames, type, campaignId) {
    const log = (msg) => logToConsole(msg, type);

    // 💡 画面上のアップロードセルをローディング表示にする
    if (type === 'haishin' && campaignId) {
        activeUploadingCampaignId = campaignId;
        renderCampaignGrid();
    }

    try {
        // 💡 インサート前に、店舗マスタに 'unknown' コードが登録されていることを確認・保証する
        // これにより外部キー制約エラーを回避
        if (supabaseClient) {
            const hasUnknown = storesCache.some(s => s.store_code === 'unknown');
            if (!hasUnknown) {
                const unknownStore = {
                    store_code: 'unknown',
                    ss_code: 'unknown',
                    store_name: '不明な店舗',
                    area_name: '不明'
                };
                const { error: upsertErr } = await supabaseClient
                    .from('stores')
                    .upsert([unknownStore]);
                if (!upsertErr) {
                    storesCache.push(unknownStore);
                } else {
                    console.error("Failed to create unknown store in DB:", upsertErr);
                }
            }
        }

        log("🧹 個人情報（PII）列のドロップおよびハッシュ化（並行処理）を開始...");

        // 削除対象列の定義 (平文で個人情報が混入するリスクの高い項目およびフリーテキスト欄)
        const columnsToRemoveHaishin = [
            "携帯電話番号", "自宅電話番号", "顧客名", "フリガナ",
            "ナンバー（陸事）", "ナンバー（種別）", "ナンバー（かな）", "ナンバー（車番）",
            "email", "住所", "郵便番号", "担当者",
            "コメント", "備考", "メモ", "連絡事項", "備考欄", "その他"
        ];
        const columnsToRemoveNyuko = [
            "お客様名", "ふりがな", "連絡先電話番号（自宅）", "連絡先電話番号（携帯）",
            "メールアドレス",
            "コメント", "備考", "メモ", "連絡事項", "備考欄", "その他", "予約時コメント", "受付時コメント"
        ];

        const targetRemoveCols = type === 'haishin' ? columnsToRemoveHaishin : columnsToRemoveNyuko;
        const fields = fieldnames || [];
        const removedCount = fields.filter(f => targetRemoveCols.includes(f)).length;
        log(`🔒 PII対象列を特定: ${removedCount} 列を除去します。`);

        const cleanRecords = [];
        let piiScannedBlocked = false;
        const warningLogs = [];

        // 疑わしい電話番号やメールアドレスが残っていないか検証するための正規表現
        const phoneRegex = /0[789]0-?\d{4}-?\d{4}|0\d-?\d{4}-?\d{4}/; // 携帯・固定電話

        // あいまい店舗名マッチングのクリーンアップヘルパー
        const cleanStr = (str) => String(str).toLowerCase()
            .replace(/[\s　]+/g, '')          // スペース除去
            .replace(/セルフ/g, '')           // 「セルフ」除去
            .replace(/dr\.drive|dr\-|dd/g, '') // 「Dr.Drive」「DD」など除去
            .replace(/店$/g, '');             // 末尾の「店」除去

        // 💡 処理の並行処理化（Promise.all）により、大容量CSVでもメインスレッドをフリーズさせずに一瞬で処理
        const processRowPromises = rows.map(async (row, idx) => {
            if (piiScannedBlocked) return null;

            const newRow = {};
            // 1. PII列以外のクリーンなデータを移行
            for (const [key, val] of Object.entries(row)) {
                if (!targetRemoveCols.includes(key)) {
                    newRow[key] = val;
                }
            }

            // 2. 突合キーの不可逆ハッシュ化(SHA-256)
            let rawKeyId = "";
            if (type === 'haishin') {
                rawKeyId = row["ID"] || row["顧客コード"] || row["車台番号"] || "";
            } else {
                rawKeyId = row["受注ID"] || row["連携先システム顧客ID"] || row["予約ID"] || "";
            }

            newRow["hashed_customer_id"] = rawKeyId ? await sha256(rawKeyId) : "";

            // 元の生キー情報の削除
            delete newRow["顧客コード"];
            delete newRow["ID"];
            delete newRow["受注ID"];
            delete newRow["連携先システム顧客ID"];

            // 3. 送信前バリデーション (PII混入チェック)
            // 💡 データベースに平文で登録される基本項目（ストアコードや予約IDなど）に限定して電話番号の混入をスキャンします。
            // データベースに保存されず破棄される「コメント」などの不要な列に電話番号が含まれていても、漏洩リスクはないため安全にスルーします。
            const validationTargets = {};
            if (type === 'haishin') {
                validationTargets["発券SSコード"] = row["発券SSコード"] || row["SSコード"] || "";
                validationTargets["店舗名"] = row["店舗名"] || row["店舗"] || "";
            } else {
                validationTargets["予約ID"] = row["予約ID"] || "";
                validationTargets["予約受付店舗ID"] = row["予約受付店舗ID"] || "";
                validationTargets["予約経路"] = row["予約経路"] || "";
            }

            for (const [k, v] of Object.entries(validationTargets)) {
                if (v && phoneRegex.test(String(v))) {
                    piiScannedBlocked = true;
                    log(`⚠️ 危険: レコード #${idx+1} の基本項目 [${k}] に個人情報(電話番号等)の混入を検知しました！`);
                    return null;
                }
            }

            // 4. DB適合整形
            if (type === 'haishin') {
                const csvStoreName = newRow["店舗名"] || newRow["店舗"] || "";
                const csvStoreCode = (newRow["発券SSコード"] || newRow["SSコード"] || "").trim();
                let matchedStoreCode = "";

                // 1. SSコード(ss_code)から店舗マスタ上の店舗ID(store_code)を検索
                if (csvStoreCode) {
                    const store = storesCache.find(s => s.ss_code === csvStoreCode);
                    if (store) {
                        matchedStoreCode = store.store_code;
                    }
                }

                // 2. 見つからず店舗名がある場合、店舗名からあいまい検索を試みる
                if (!matchedStoreCode && csvStoreName) {
                    const cleanedCsv = cleanStr(csvStoreName);
                    if (cleanedCsv) {
                        // 1. クリーン後の完全一致
                        let matchedStore = storesCache.find(s => cleanStr(s.store_name) === cleanedCsv);
                        // 2. 部分一致
                        if (!matchedStore) {
                            matchedStore = storesCache.find(s => {
                                const cleanedMaster = cleanStr(s.store_name);
                                return cleanedMaster.includes(cleanedCsv) || cleanedCsv.includes(cleanedMaster);
                            });
                        }
                        if (matchedStore) {
                            matchedStoreCode = matchedStore.store_code;
                        }
                    }
                }

                // 3. 予備的に直接店舗ID(store_code)に一致するものがあるか確認
                if (!matchedStoreCode && csvStoreCode) {
                    const store = storesCache.find(s => s.store_code === csvStoreCode);
                    if (store) {
                        matchedStoreCode = store.store_code;
                    }
                }

                // マスタに合致するコードがない場合、警告をログに蓄積して 'unknown' に
                if (!matchedStoreCode) {
                    warningLogs.push(`⚠️ 警告: レコード #${idx+1} の店舗名「${csvStoreName || '未指定'}」(CSVコード:「${csvStoreCode || '未指定'}」) は店舗マスタに適合しません。コード「unknown」として処理されます。`);
                    matchedStoreCode = "unknown";
                }

                return {
                    campaign_id: campaignId,
                    store_code: matchedStoreCode,
                    hashed_customer_id: newRow["hashed_customer_id"],
                    sms_count: parseInt(newRow["通数"]) || 1
                };
            } else {
                const csvStoreName = newRow["予約受付店舗"] || "";
                const csvStoreCode = (newRow["予約受付店舗ID"] || "").trim();
                let matchedStoreCode = "";

                // 1. 店舗ID(store_code)から店舗マスタを直接検索
                if (csvStoreCode) {
                    const store = storesCache.find(s => s.store_code === csvStoreCode);
                    if (store) {
                        matchedStoreCode = store.store_code;
                    }
                }

                // 2. 見つからない場合、店舗名からあいまい検索を試みる
                if (!matchedStoreCode && csvStoreName) {
                    const cleanedCsv = cleanStr(csvStoreName);
                    if (cleanedCsv) {
                        // 1. クリーン後の完全一致
                        let matchedStore = storesCache.find(s => cleanStr(s.store_name) === cleanedCsv);
                        // 2. 部分一致
                        if (!matchedStore) {
                            matchedStore = storesCache.find(s => {
                                const cleanedMaster = cleanStr(s.store_name);
                                return cleanedMaster.includes(cleanedCsv) || cleanedCsv.includes(cleanedMaster);
                            });
                        }
                        if (matchedStore) {
                            matchedStoreCode = matchedStore.store_code;
                        }
                    }
                }

                // それでも一致しない場合は警告を出して 'unknown' に
                if (!matchedStoreCode) {
                    warningLogs.push(`⚠️ 警告: レコード #${idx+1} の店舗名「${csvStoreName || '未指定'}」(CSVコード:「${csvStoreCode || '未指定'}」) は店舗マスタに適合しません。コード「unknown」として処理されます。`);
                    matchedStoreCode = "unknown";
                }

                return {
                    reservation_id: newRow["予約ID"],
                    reception_date: newRow["受付日"],
                    work_group: newRow["作業グループ"],
                    store_code: matchedStoreCode,
                    hashed_customer_id: newRow["hashed_customer_id"],
                    route: newRow["予約経路"],
                    route_store: newRow["予約経路_店頭入力用"],
                    status: newRow["ステータス"]
                };
            }
        });

        const processResults = await Promise.all(processRowPromises);
        
        // 💡 蓄積された警告ログをまとめて出力（大量のDOM操作によるフリーズを防止）
        if (warningLogs.length > 0) {
            log(`📝 店舗コード不一致の警告が ${warningLogs.length} 件発生しました。`);
            const maxShow = 20;
            warningLogs.slice(0, maxShow).forEach(msg => log(msg));
            if (warningLogs.length > maxShow) {
                log(`...（他 ${warningLogs.length - maxShow} 件の警告は省略されました。ブラウザのデベロッパーツールで確認できます）`);
                // 開発者用にブラウザのコンソールに全件出力
                warningLogs.slice(maxShow).forEach(msg => console.log(msg));
            }
        }
        
        if (piiScannedBlocked) {
            log(`🚨 アップロードを強制停止しました。個人情報は送信されていません。`);
            showToast("🚨 個人情報の混入検知により処理を停止しました。", "error");
            return;
        }

        const validCleanRecords = processResults.filter(r => r !== null);
        log(`✅ PII除去＆ハッシュ化の検証を通過しました（クリーン件数: ${validCleanRecords.length}件）。`);
        log("🚀 データベースへインポート中...");

        if (!supabaseClient) {
            // オフライン・デモの場合
            log(`💡 デモモード: メモリ上に一時格納しました (${validCleanRecords.length} 件)。`);
            if (type === 'haishin') {
                smsDeliveriesCache = smsDeliveriesCache.filter(d => d.campaign_id !== campaignId);
                smsDeliveriesCache.push(...validCleanRecords);
            } else {
                const newIds = validCleanRecords.map(r => r.reservation_id);
                reservationsCache = reservationsCache.filter(r => !newIds.includes(r.reservation_id));
                reservationsCache.push(...validCleanRecords);
            }
            log("🎉 インポート成功（デモ）！ダッシュボードに反映されました。");
            showToast("📥 データを一時インポートしました（デモ）。", "success");
            renderCampaignGrid();
            loadAllData();
            return;
        }

        // 💡 nyuko の場合、すでに同じ予約IDが存在し予約日が異なっているなら previous_reception_date に退避する
        if (type === 'nyuko') {
            log("🔍 既存の予約IDと日付の重複チェックおよび変更前の予約日退避処理を実行中...");
            const reservationIds = validCleanRecords.map(r => r.reservation_id).filter(Boolean);
            
            const existingMap = {};
            for (let offset = 0; offset < reservationIds.length; offset += 1000) {
                const chunkIds = reservationIds.slice(offset, offset + 1000);
                const { data, error } = await supabaseClient
                    .from('reservations')
                    .select('reservation_id, reception_date, previous_reception_date')
                    .in('reservation_id', chunkIds);
                
                if (!error && data) {
                    data.forEach(item => {
                        existingMap[item.reservation_id] = {
                            reception_date: item.reception_date,
                            previous_reception_date: item.previous_reception_date
                        };
                    });
                }
            }

            validCleanRecords.forEach(record => {
                const existing = existingMap[record.reservation_id];
                if (existing) {
                    const csvDate = record.reception_date;
                    const dbDate = existing.reception_date;
                    
                    if (csvDate !== dbDate) {
                        record.previous_reception_date = dbDate;
                        log(`🔄 予約ID「${record.reservation_id}」の日程変更を検出: ${dbDate} ➔ ${csvDate}`);
                    } else {
                        record.previous_reception_date = existing.previous_reception_date;
                    }
                }
            });
        }

        const table = type === 'haishin' ? 'sms_deliveries' : 'reservations';
        
        // 重複排除 (上書き対応)
        if (type === 'haishin') {
            const { error: delErr } = await supabaseClient.from('sms_deliveries').delete().eq('campaign_id', campaignId);
            if (delErr) throw delErr;
        }

        // 💡 データの分割（チャンク）バッチインサート/アップサートの実装（1000件単位）
        const CHUNK_SIZE = 1000;
        let insertedCount = 0;
        
        for (let i = 0; i < validCleanRecords.length; i += CHUNK_SIZE) {
            const chunk = validCleanRecords.slice(i, i + CHUNK_SIZE);
            const chunkIndex = Math.floor(i / CHUNK_SIZE) + 1;
            const totalChunks = Math.ceil(validCleanRecords.length / CHUNK_SIZE);
            
            log(`   [${chunkIndex}/${totalChunks}] チャンクを送信中 (${chunk.length}件)...`);
            
            let error;
            if (type === 'haishin') {
                const res = await supabaseClient.from(table).insert(chunk);
                error = res.error;
            } else {
                chunk.forEach(r => {
                    r.updated_at = new Date().toISOString();
                });
                const res = await supabaseClient.from(table).upsert(chunk, { onConflict: 'reservation_id' });
                error = res.error;
            }
            if (error) throw error;
            
            insertedCount += chunk.length;
        }

        log(`🎉 アップロードが成功しました！ 合計 ${insertedCount} 件のレコードが登録・更新されました。`);
        showToast("📥 データのインポートが完了しました！", "success");
        
        // クライアント側のメモリキャッシュへ即座に手動マージ（反映ラグ対策）
        if (type === 'haishin') {
            smsDeliveriesCache = smsDeliveriesCache.filter(d => d.campaign_id !== campaignId);
            smsDeliveriesCache.push(...validCleanRecords);
            
            log("🔄 CSVインポート完了に伴い、グリッド設定を自動セーブしてデータベースへの永続化を確定しています...");
            await saveCampaignGrid(true);
        } else {
            await loadReservationsList();
            loadAllData();
        }
    } catch (err) {
        console.error(err);
        logToConsole(`❌ インポート失敗エラー: ${err.message || err}`);
        showToast("❌ データの登録に失敗しました。", "error");
    } finally {
        // 💡 ローディング表示を解除して画面を再描画
        if (type === 'haishin' && campaignId) {
            activeUploadingCampaignId = null;
            renderCampaignGrid();
        }
    }
}


// ==========================================================================
// 8.2. 新設「入庫予約管理」機能の実装
// ==========================================================================

// 入庫データのロード
async function loadReservationsList() {
    if (!supabaseClient) {
        logToConsole("⚠️ Supabase未接続のため、デモ用入庫データを使用します。", "nyuko");
        renderReservationGrid();
        await updateMonthlySummary();
        return;
    }

    // ロード中表示
    const tbody = document.getElementById('reservation-list-body');
    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 24px;">データを読み込んでいます...</td></tr>';
    }

    try {
        logToConsole("⏳ データベースから入庫予約データを読み込み中...", "nyuko");
        
        // 検索・フィルター条件の取得
        const startMonth = document.getElementById('filter-res-start-month')?.value; // YYYY-MM
        const endMonth = document.getElementById('filter-res-end-month')?.value;     // YYYY-MM
        const storeCode = document.getElementById('filter-res-store')?.value;
        const route = document.getElementById('filter-res-route')?.value;
        const rescheduledOnly = document.getElementById('filter-res-rescheduled-only')?.checked;

        // クエリの作成
        let query = supabaseClient
            .from('reservations')
            .select(`
                id,
                reservation_id,
                reception_date,
                previous_reception_date,
                work_group,
                store_code,
                hashed_customer_id,
                route,
                route_store,
                status,
                created_at,
                updated_at,
                stores (
                    store_name
                )
            `);

        // フィルター条件の適用
        if (startMonth) {
            query = query.gte('reception_date', `${startMonth}-01`);
        }
        if (endMonth) {
            const parts = endMonth.split('-');
            const nextM = parseInt(parts[1]) + 1;
            const nextMonthStr = nextM > 12 ? `${parseInt(parts[0]) + 1}-01` : `${parts[0]}-${String(nextM).padStart(2, '0')}`;
            query = query.lt('reception_date', `${nextMonthStr}-01`);
        }
        if (storeCode && storeCode !== 'all') {
            query = query.eq('store_code', storeCode);
        }
        if (route && route !== 'all') {
            query = query.eq('route', route);
        }
        if (rescheduledOnly) {
            query = query.not('previous_reception_date', 'is', null);
        }

        // ソート順と件数制限 (最新1000件のみ)
        query = query.order('updated_at', { ascending: false }).limit(1000);

        const { data, error } = await query;
        if (error) throw error;

        // グローバル全件キャッシュを破壊せず、明細専用キャッシュに退避
        reservationsListCache = (data || []).map(item => ({
            ...item,
            store_name: item.stores ? item.stores.store_name : '不明な店舗'
        }));

        logToConsole(`✅ 入庫予約データをロード完了 (${reservationsListCache.length}件)`, "nyuko");
        
        // 店舗フィルターのオプションを動的に再構築
        buildReservationStoreFilter();
        
        // 描画実行
        renderReservationGrid();

        // 月別サマリーも更新
        await updateMonthlySummary();
    } catch (err) {
        console.error(err);
        logToConsole(`❌ 入庫データのロード失敗: ${err.message || err}`, "nyuko");
        showToast("❌ 入庫データの取得に失敗しました。", "error");
    }
}

// 月別サマリーの更新
async function updateMonthlySummary() {
    const listContainer = document.getElementById('monthly-summary-list');
    if (!listContainer) return;

    const storeCode = document.getElementById('filter-res-store')?.value;
    const route = document.getElementById('filter-res-route')?.value;
    const rescheduledOnly = document.getElementById('filter-res-rescheduled-only')?.checked;

    let monthlyData = [];

    if (supabaseClient) {
        try {
            // ビューからデータを取得
            let query = supabaseClient.from('monthly_reservation_summary').select('*');
            if (storeCode && storeCode !== 'all') {
                query = query.eq('store_code', storeCode);
            }
            if (route && route !== 'all') {
                query = query.eq('route', route);
            }
            if (rescheduledOnly) {
                query = query.eq('rescheduled', true);
            }

            const { data, error } = await query;
            if (error) throw error;

            // 月ごとに集計をマージ
            const summaryMap = {};
            (data || []).forEach(row => {
                const m = row.month;
                const c = parseInt(row.count) || 0;
                summaryMap[m] = (summaryMap[m] || 0) + c;
            });

            // キー（月）でソート（降順）
            monthlyData = Object.entries(summaryMap).map(([month, count]) => ({ month, count }))
                .sort((a, b) => b.month.localeCompare(a.month));

        } catch (err) {
            console.error("月別サマリーの取得失敗:", err);
            listContainer.innerHTML = `<span style="color: var(--danger); font-size: 12px;">⚠️ サマリーの取得に失敗しました: ${err.message || err}</span>`;
            return;
        }
    } else {
        // デモモード：ローカルキャッシュから集計
        let filtered = [...reservationsCache];
        if (storeCode && storeCode !== 'all') {
            filtered = filtered.filter(r => r.store_code === storeCode);
        }
        if (route && route !== 'all') {
            filtered = filtered.filter(r => r.route === route);
        }
        if (rescheduledOnly) {
            filtered = filtered.filter(r => r.previous_reception_date !== null && r.previous_reception_date !== undefined);
        }

        const summaryMap = {};
        filtered.forEach(r => {
            if (r.reception_date) {
                const m = r.reception_date.substring(0, 7); // YYYY-MM
                summaryMap[m] = (summaryMap[m] || 0) + 1;
            }
        });

        monthlyData = Object.entries(summaryMap).map(([month, count]) => ({ month, count }))
            .sort((a, b) => b.month.localeCompare(a.month));
    }

    // 描画
    if (monthlyData.length === 0) {
        listContainer.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">データがありません。</span>';
        return;
    }

    listContainer.innerHTML = '';
    
    // 現在選択されている月を取得
    const filterStart = document.getElementById('filter-res-start-month')?.value;
    const filterEnd = document.getElementById('filter-res-end-month')?.value;

    monthlyData.forEach(item => {
        const badge = document.createElement('div');
        const isActive = (filterStart === item.month && filterEnd === item.month);
        
        badge.className = `badge monthly-summary-badge ${isActive ? 'active' : ''}`;
        
        // スタイルを設定 (Vibrant UI Aesthetics)
        badge.style.padding = '6px 12px';
        badge.style.borderRadius = '20px';
        badge.style.fontSize = '12px';
        badge.style.fontWeight = '600';
        badge.style.cursor = 'pointer';
        badge.style.display = 'inline-flex';
        badge.style.alignItems = 'center';
        badge.style.gap = '6px';
        badge.style.transition = 'all 0.2s ease';
        
        if (isActive) {
            badge.style.background = 'linear-gradient(135deg, #3b82f6, #2563eb)';
            badge.style.color = '#ffffff';
            badge.style.boxShadow = '0 0 10px rgba(59, 130, 246, 0.5)';
            badge.style.border = '1px solid #60a5fa';
        } else {
            badge.style.background = 'rgba(30, 41, 59, 0.6)';
            badge.style.color = 'var(--text-main)';
            badge.style.border = '1px solid var(--border-color)';
        }

        // ホバーエフェクト
        badge.onmouseover = () => {
            if (!isActive) {
                badge.style.background = 'rgba(59, 130, 246, 0.15)';
                badge.style.borderColor = '#3b82f6';
            }
        };
        badge.onmouseout = () => {
            if (!isActive) {
                badge.style.background = 'rgba(30, 41, 59, 0.6)';
                badge.style.borderColor = 'var(--border-color)';
            }
        };

        const year = item.month.substring(0, 4);
        const monthNum = parseInt(item.month.substring(5, 7));
        badge.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar" style="margin-right: 4px;"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>${year}年${monthNum}月 <span style="opacity: 0.8; font-weight: normal;">(${item.count}件)</span>`;
        
        badge.onclick = () => {
            const startInput = document.getElementById('filter-res-start-month');
            const endInput = document.getElementById('filter-res-end-month');
            if (!startInput || !endInput) return;

            if (isActive) {
                // すでに選択されている月を再度クリックした場合はクリア
                startInput.value = '';
                endInput.value = '';
            } else {
                // 選択した月にセット
                startInput.value = item.month;
                endInput.value = item.month;
            }
            applyReservationFilters();
        };

        listContainer.appendChild(badge);
    });
}

// 店舗フィルターの構築
function buildReservationStoreFilter() {
    const select = document.getElementById('filter-res-store');
    if (!select) return;

    // 現在の選択値を維持
    const curVal = select.value;
    select.innerHTML = '<option value="all">すべての店舗</option>';

    // 重複のない店舗一覧を取得
    const uniqueStores = [];
    storesCache.forEach(s => {
        if (s.store_code !== 'unknown' && !uniqueStores.some(u => u.store_code === s.store_code)) {
            uniqueStores.push(s);
        }
    });

    uniqueStores.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.store_code;
        opt.textContent = s.store_name;
        select.appendChild(opt);
    });

    select.value = curVal;
}

// 明細データの描画
function renderReservationGrid() {
    const tbody = document.getElementById('reservation-list-body');
    const countSpan = document.getElementById('reservation-list-count');
    if (!tbody) return;

    let displayData = [];
    if (supabaseClient) {
        // オンライン時は、すでにAPIクエリ側で絞り込まれた reservationsListCache を使用
        displayData = [...reservationsListCache];
    } else {
        // オフライン（デモモード）時は、全件が入っている reservationsCache から絞り込む
        const startMonth = document.getElementById('filter-res-start-month')?.value;
        const endMonth = document.getElementById('filter-res-end-month')?.value;
        const storeCode = document.getElementById('filter-res-store')?.value;
        const route = document.getElementById('filter-res-route')?.value;
        const rescheduledOnly = document.getElementById('filter-res-rescheduled-only')?.checked;

        displayData = [...reservationsCache];

        if (startMonth) {
            displayData = displayData.filter(r => r.reception_date >= `${startMonth}-01`);
        }
        if (endMonth) {
            const parts = endMonth.split('-');
            const nextM = parseInt(parts[1]) + 1;
            const nextMonthStr = nextM > 12 ? `${parseInt(parts[0]) + 1}-01` : `${parts[0]}-${String(nextM).padStart(2, '0')}`;
            displayData = displayData.filter(r => r.reception_date < `${nextMonthStr}-01`);
        }
        if (storeCode && storeCode !== 'all') {
            displayData = displayData.filter(r => r.store_code === storeCode);
        }
        if (route && route !== 'all') {
            displayData = displayData.filter(r => r.route === route);
        }
        if (rescheduledOnly) {
            displayData = displayData.filter(r => r.previous_reception_date !== null && r.previous_reception_date !== undefined);
        }
    }

    // テーブル描画
    if (displayData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 24px;">該当する入庫データが見つかりません。</td></tr>';
        if (countSpan) countSpan.textContent = "表示件数: 0 件";
        return;
    }

    tbody.innerHTML = '';
    displayData.forEach(r => {
        const tr = document.createElement('tr');
        
        let dateHtml = r.reception_date;
        if (r.previous_reception_date) {
            dateHtml = `<span style="text-decoration: line-through; color: var(--text-muted); font-size: 11px;">${r.previous_reception_date}</span><br>➔ <span style="color: var(--secondary); font-weight: 600;">${r.reception_date}</span>`;
            tr.style.background = 'rgba(59, 130, 246, 0.05)';
        }

        const shortCustId = r.hashed_customer_id ? `${r.hashed_customer_id.substring(0, 10)}...` : 'なし';
        const updatedTimeStr = r.updated_at ? new Date(r.updated_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '-';

        tr.innerHTML = `
            <td style="font-family: monospace; font-weight: 600;">${r.reservation_id || '-'}</td>
            <td>${r.store_name || '不明な店舗'}</td>
            <td><span class="badge" style="background: rgba(147, 197, 253, 0.15); color: #93c5fd; padding: 4px 8px; border-radius: 4px;">${r.work_group || '-'}</span></td>
            <td>${dateHtml}</td>
            <td><span class="badge" style="background: rgba(110, 231, 183, 0.15); color: #6ee7b7; padding: 4px 8px; border-radius: 4px;">${r.route || '-'}</span></td>
            <td><span class="badge" style="background: rgba(244, 63, 94, 0.15); color: #f43f5e; padding: 4px 8px; border-radius: 4px;">${r.status || '-'}</span></td>
            <td style="font-family: monospace; color: var(--text-muted); font-size: 11px;" title="${r.hashed_customer_id || ''}">${shortCustId}</td>
            <td style="color: var(--text-muted); font-size: 11px;">${updatedTimeStr}</td>
            <td style="white-space: nowrap; text-align: center;">
                <button class="btn btn-secondary" style="padding: 4px 6px; font-size: 11px; display: inline-flex; align-items: center; justify-content: center;" onclick="openEditReservationModal('${r.id}')" title="編集">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </button>
                <button class="btn btn-danger" style="padding: 4px 6px; font-size: 11px; margin-left: 4px; display: inline-flex; align-items: center; justify-content: center;" onclick="deleteReservation('${r.id}', '${r.reservation_id}')" title="削除">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    if (countSpan) {
        countSpan.textContent = `表示件数: ${displayData.length} 件`;
    }
}

async function applyReservationFilters() {
    await loadReservationsList();
}

// 入庫予約データのCRUD操作モーダル制御
function openAddReservationModal() {
    const modal = document.getElementById('res-edit-modal');
    if (!modal) return;

    document.getElementById('res-modal-title').textContent = '入庫予約データの追加';
    document.getElementById('res-modal-id').value = '';
    document.getElementById('res-modal-reservation-id').value = '';
    document.getElementById('res-modal-reservation-id').readOnly = false;
    document.getElementById('res-modal-work-group').value = '';
    document.getElementById('res-modal-reception-date').value = new Date().toISOString().substring(0, 10);
    document.getElementById('res-modal-route').value = '入庫予約';
    document.getElementById('res-modal-status').value = '本予約';
    document.getElementById('res-modal-customer-id').value = '';

    // 店舗セレクトの構築
    const select = document.getElementById('res-modal-store-code');
    if (select) {
        select.innerHTML = '';
        storesCache.forEach(s => {
            if (s.store_code && s.store_code !== 'unknown') {
                const opt = document.createElement('option');
                opt.value = s.store_code;
                opt.textContent = `${s.store_name} (${s.store_code})`;
                select.appendChild(opt);
            }
        });
    }

    modal.style.display = 'flex';
}

function openEditReservationModal(id) {
    const modal = document.getElementById('res-edit-modal');
    if (!modal) return;

    // 対象データの取得
    const item = reservationsListCache.find(r => r.id === id);
    if (!item) {
        showToast("❌ 編集対象データが見つかりません。", "error");
        return;
    }

    document.getElementById('res-modal-title').textContent = '入庫予約データの編集';
    document.getElementById('res-modal-id').value = item.id;
    document.getElementById('res-modal-reservation-id').value = item.reservation_id || '';
    document.getElementById('res-modal-reservation-id').readOnly = true; // 予約IDは主キーに近いため編集不可に
    document.getElementById('res-modal-work-group').value = item.work_group || '';
    document.getElementById('res-modal-reception-date').value = item.reception_date || '';
    document.getElementById('res-modal-route').value = item.route || '入庫予約';
    document.getElementById('res-modal-status').value = item.status || '本予約';
    document.getElementById('res-modal-customer-id').value = item.hashed_customer_id || '';

    // 店舗セレクトの構築
    const select = document.getElementById('res-modal-store-code');
    if (select) {
        select.innerHTML = '';
        storesCache.forEach(s => {
            if (s.store_code && s.store_code !== 'unknown') {
                const opt = document.createElement('option');
                opt.value = s.store_code;
                opt.textContent = `${s.store_name} (${s.store_code})`;
                select.appendChild(opt);
            }
        });
        select.value = item.store_code;
    }

    modal.style.display = 'flex';
}

function closeResEditModal() {
    const modal = document.getElementById('res-edit-modal');
    if (modal) modal.style.display = 'none';
}

async function handleSaveReservation(e) {
    e.preventDefault();

    const id = document.getElementById('res-modal-id').value;
    const reservationId = document.getElementById('res-modal-reservation-id').value.trim();
    const storeCode = document.getElementById('res-modal-store-code').value;
    const workGroup = document.getElementById('res-modal-work-group').value.trim();
    const receptionDate = document.getElementById('res-modal-reception-date').value;
    const route = document.getElementById('res-modal-route').value;
    const status = document.getElementById('res-modal-status').value;
    const customerId = document.getElementById('res-modal-customer-id').value.trim();

    if (!reservationId || !storeCode || !workGroup || !receptionDate) {
        showToast("❌ 必須項目を入力してください。", "error");
        return;
    }

    const payload = {
        reservation_id: reservationId,
        store_code: storeCode,
        work_group: workGroup,
        reception_date: receptionDate,
        route: route,
        status: status,
        hashed_customer_id: customerId || null,
        updated_at: new Date().toISOString()
    };

    try {
        if (!supabaseClient) {
            // デモモード（オフライン時）：ローカルキャッシュを疑似操作
            if (id) {
                // 編集
                const idx = reservationsCache.findIndex(r => r.id === id);
                if (idx !== -1) {
                    const store = storesCache.find(s => s.store_code === storeCode);
                    reservationsCache[idx] = {
                        ...reservationsCache[idx],
                        ...payload,
                        store_name: store ? store.store_name : '不明な店舗'
                    };
                }
            } else {
                // 新規追加
                const store = storesCache.find(s => s.store_code === storeCode);
                const newId = 'demo-' + Math.random().toString(36).substr(2, 9);
                reservationsCache.push({
                    id: newId,
                    ...payload,
                    store_name: store ? store.store_name : '不明な店舗',
                    created_at: new Date().toISOString()
                });
            }
            showToast("✅ [デモ] 予約データを保存しました。");
            closeResEditModal();
            renderReservationGrid();
            await updateMonthlySummary();
            return;
        }

        // オンライン（Supabase接続時）
        if (id) {
            // 編集（UUIDによるupdate）
            const { error } = await supabaseClient
                .from('reservations')
                .update(payload)
                .eq('id', id);
            if (error) throw error;
            showToast("✅ 予約データを更新しました。");
        } else {
            // 新規追加
            const { error } = await supabaseClient
                .from('reservations')
                .insert([{
                    ...payload,
                    created_at: new Date().toISOString()
                }]);
            if (error) throw error;
            showToast("✅ 新規予約データを追加しました。");
        }

        closeResEditModal();
        await loadReservationsList();
    } catch (err) {
        console.error(err);
        showToast(`❌ 保存に失敗しました: ${err.message || err}`, "error");
    }
}

async function deleteReservation(id, reservationId) {
    showCustomConfirm(
        `予約ID [${reservationId}] のデータを削除しますか？<br><br><span style="color: var(--danger); font-weight: bold;">※この操作は取り消せません。</span>`,
        async () => {
            try {
                if (!supabaseClient) {
                    // デモモード：キャッシュから削除
                    reservationsCache = reservationsCache.filter(r => r.id !== id);
                    showToast("✅ [デモ] データを削除しました。");
                    renderReservationGrid();
                    await updateMonthlySummary();
                    return;
                }

                // オンライン
                const { error } = await supabaseClient
                    .from('reservations')
                    .delete()
                    .eq('id', id);
                if (error) throw error;

                showToast("✅ データを削除しました。");
                await loadReservationsList();
            } catch (err) {
                console.error(err);
                showToast(`❌ 削除に失敗しました: ${err.message || err}`, "error");
            }
        }
    );
}

async function deleteAllReservations() {
    showCustomConfirm(
        `すべての入庫予約データを完全に消去して、クリーンにしますか？<br><br><span style="color: var(--danger); font-weight: bold;">※この操作は取り消せません。現在登録されているすべての予約明細が消去されます。</span>`,
        async () => {
            try {
                if (!supabaseClient) {
                    // デモモード：キャッシュクリア
                    reservationsCache = [];
                    showToast("✅ [デモ] すべてのデータをクリアしました。");
                    renderReservationGrid();
                    await updateMonthlySummary();
                    return;
                }

                // オンライン：全件削除
                const { error } = await supabaseClient
                    .from('reservations')
                    .delete()
                    .neq('id', '00000000-0000-0000-0000-000000000000'); // 全削除用のダミー条件
                if (error) throw error;

                showToast("✅ すべての予約データをクリアしました。");
                await loadReservationsList();
            } catch (err) {
                console.error(err);
                showToast(`❌ クリアに失敗しました: ${err.message || err}`, "error");
            }
        }
    );
}


// 9. 店舗マスタ ＆ 店舗独自SMS of 編集UIの実装

async function loadStoresMaster() {
    const tbody = document.getElementById('stores-master-body');
    if (storesCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">店舗データがありません。左下のボタンから店舗を追加してください。</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    storesCache.forEach((store, idx) => {
        tbody.innerHTML += `
            <tr class="store-master-row" data-idx="${idx}" data-original-code="${store.store_code || ''}">
                <td><input type="text" class="store-code-input" value="${store.store_code || ''}" placeholder="店舗ID (例: 6921)" style="padding: 4px; font-size: 11px; width: 100%;"></td>
                <td><input type="text" class="store-ss-code-input" value="${store.ss_code || ''}" placeholder="SSコード (例: 1016229)" style="padding: 4px; font-size: 11px; width: 100%;"></td>
                <td><input type="text" class="store-name-input" value="${store.store_name || ''}" placeholder="店舗名" style="padding: 4px; font-size: 11px; width: 100%;"></td>
                <td><input type="text" class="store-area-input" value="${store.area_name || ''}" placeholder="エリア名 (例: 中国1G)" style="padding: 4px; font-size: 11px; width: 100%;"></td>
            </tr>
        `;
    });
}

// 店舗マスタに行を追加
function addStoreMasterRow() {
    storesCache.push({
        store_code: "",
        ss_code: "",
        store_name: "",
        area_name: "",
        isNew: true
    });
    loadStoresMaster();
}

// 店舗マスタ変更保存
async function saveStoresMaster() {
    const rows = document.querySelectorAll('.store-master-row');
    const updates = [];
    const deleteCodes = [];
    let hasError = false;

    rows.forEach(row => {
        const codeInput = row.querySelector('.store-code-input');
        const ssCodeInput = row.querySelector('.store-ss-code-input');
        const nameInput = row.querySelector('.store-name-input');
        const areaInput = row.querySelector('.store-area-input');
        const originalCode = row.dataset.originalCode || "";

        const code = codeInput.value.trim();
        const ssCode = ssCodeInput.value.trim();
        const name = nameInput.value.trim();
        const area = areaInput.value.trim();

        if (!code || !name || !area) {
            hasError = true;
            return;
        }

        updates.push({
            store_code: code,
            ss_code: ssCode || null,
            store_name: name,
            area_name: area
        });

        // 元のコードが存在し、新しく変更された場合は古いコードを削除対象にする
        if (originalCode && originalCode !== code) {
            deleteCodes.push(originalCode);
        }
    });

    if (hasError) {
        showToast("❌ 店舗ID、店舗名、エリア名はすべて入力してください。", "error");
        return;
    }

    if (updates.length === 0) {
        showToast("💡 保存する店舗データがありません。", "warning");
        return;
    }

    if (!supabaseClient) {
        // デモモード用の一時保存
        storesCache = updates.map(u => ({ ...u, isNew: false }));
        showToast("💾 店舗マスタを一時保存しました（デモ）。", "success");
        loadAllData();
        return;
    }

    try {
        // 1. コードが変更された古いレコードを削除（DBのゴミ化を防ぐ）
        if (deleteCodes.length > 0) {
            const { error: delErr } = await supabaseClient
                .from('stores')
                .delete()
                .in('store_code', deleteCodes);
            if (delErr) throw delErr;
        }

        // 2. 新しいデータ（変更後を含む）をupsert
        const { error } = await supabaseClient.from('stores').upsert(updates);
        if (error) throw error;

        showToast("💾 店舗マスタの変更を保存しました。", "success");
        await loadInitialData();
        loadStoresMaster();
    } catch (err) {
        console.error(err);
        showToast("❌ 店舗マスタの保存に失敗しました。", "error");
    }
}

// 2連CSVインポートモーダルの開閉
function openStoreImportModal() {
    document.getElementById('store-import-modal').style.display = 'flex';
}

function closeStoreImportModal() {
    document.getElementById('store-import-modal').style.display = 'none';
}

// CSVを解析するPromiseラッパー
function parseCsvPromise(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            encoding: "Shift-JIS", // Excelから出力されたShift-JISに対応
            complete: function(results) {
                resolve(results.data);
            },
            error: function(err) {
                reject(err);
            }
        });
    });
}

// 2連CSVの送信・マージ・保存処理
async function handleStoreImportSubmit(e) {
    e.preventDefault();
    const areaFile = document.getElementById('store-import-area-file').files[0];
    const belongFile = document.getElementById('store-import-belong-file').files[0];

    if (!areaFile || !belongFile) {
        showToast("❌ エリアCSVと所属CSVの両方を選択してください。", "error");
        return;
    }

    showToast("⏳ CSVの解析・マージ処理を実行中...", "info");

    try {
        const [areaData, belongData] = await Promise.all([
            parseCsvPromise(areaFile),
            parseCsvPromise(belongFile)
        ]);

        // 1. エリアIDからエリア名へのマップを作成
        const areaMap = {};
        areaData.forEach(row => {
            const id = String(row["id"] || "").trim();
            const name = String(row["name"] || "").trim();
            if (id && name) {
                areaMap[id] = name;
            }
        });

        // 2. 所属データとマージして保存用配列を作成
        // 💡 データの体系見直しにより、store_code には「店舗ID（id）」を保存し、新たに「ss_code」カラムにSSコードを保存します。
        const updates = [];
        belongData.forEach(row => {
            const storeId = String(row["id"] || "").trim(); // 店舗ID
            const name = String(row["name"] || "").trim();
            const areaId = String(row["nskn_area_id"] || "").trim();
            const areaName = areaMap[areaId] || "その他";

            let ssCode = String(row["ss_code"] || "").trim();
            
            // 💡 所属CSVの ss_code が空の場合、店舗名から辞書引きしてSSコードを補完する
            if (!ssCode && name) {
                const cleanedName = cleanStr(name);
                const matchedKey = Object.keys(MASTER_STORE_NAME_TO_SS_CODE).find(key => 
                    cleanedName.includes(cleanStr(key)) || cleanStr(key).includes(cleanedName)
                );
                if (matchedKey) {
                    ssCode = MASTER_STORE_NAME_TO_SS_CODE[matchedKey];
                }
            }

            if (storeId && name) {
                updates.push({
                    store_code: storeId, // 店舗IDを主キー（store_code）に設定
                    ss_code: ssCode || null, // SSコードを追加
                    store_name: name,
                    area_name: areaName
                });
            }
        });

        closeStoreImportModal();
        await saveStoreImportUpdates(updates);

        // 入力をリセット
        document.getElementById('store-import-form').reset();

    } catch (err) {
        console.error(err);
        showToast("❌ CSVの結合処理に失敗しました。ファイル形式を確認してください。", "error");
    }
}

// インポートした店舗データを保存
async function saveStoreImportUpdates(updates) {
    if (updates.length === 0) {
        showToast("❌ 有効な店舗データ（コードと店舗名）が見つかりませんでした。", "error");
        return;
    }

    if (!supabaseClient) {
        storesCache = updates;
        showToast(`💾 デモモード：${updates.length} 件の店舗を一時登録しました。`, "success");
        loadAllData();
        loadStoresMaster();
        return;
    }

    try {
        const { error } = await supabaseClient.from('stores').upsert(updates);
        if (error) throw error;

        showToast(`💾 ${updates.length} 件の店舗マスタを一括保存しました！`, "success");
        await loadInitialData();
        loadStoresMaster();
    } catch (err) {
        console.error(err);
        showToast("❌ 店舗マスタの一括保存に失敗しました。", "error");
    }
}

// 店舗独自SMS編集グリッドのロード
function loadStoreSmsGrid() {
    const tbody = document.getElementById('store-sms-grid-body');
    tbody.innerHTML = '';

    if (storeOwnSmsCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">店舗独自SMSデータがありません。行を追加してください。</td></tr>';
        return;
    }

    // 店舗選択セレクトボックスのHTMLを生成
    let storeOptions = "";
    storesCache.forEach(s => {
        storeOptions += `<option value="${s.store_code}">${s.store_name}</option>`;
    });

    storeOwnSmsCache.forEach((sms, idx) => {
        tbody.innerHTML += `
            <tr class="sms-grid-row" data-idx="${idx}">
                <td><input type="text" class="sms-month-input" value="${sms.delivery_month}" placeholder="YYYY-MM" style="padding: 6px;"></td>
                <td>
                    <select class="sms-store-input">
                        ${storesCache.map(s => `<option value="${s.store_code}" ${s.store_code === sms.store_code ? 'selected' : ''}>${s.store_name}</option>`).join('')}
                    </select>
                </td>
                <td>
                    <select class="sms-category-input">
                        <option value="オイル" ${sms.category === 'オイル' ? 'selected' : ''}>オイル</option>
                        <option value="コーティング" ${sms.category === 'コーティング' ? 'selected' : ''}>コーティング</option>
                        <option value="洗車" ${sms.category === '洗車' ? 'selected' : ''}>洗車</option>
                        <option value="車検" ${sms.category === '車検' ? 'selected' : ''}>車検</option>
                        <option value="点検" ${sms.category === '点検' ? 'selected' : ''}>点検</option>
                    </select>
                </td>
                <td><input type="number" class="sms-count-input" value="${sms.sms_count}" style="padding: 6px;"></td>
            </tr>
        `;
    });
}

// 店舗独自SMS行追加
function addStoreSmsGridRow() {
    const tbody = document.getElementById('store-sms-grid-body');
    const newIdx = storeOwnSmsCache.length;
    
    // 空行のオブジェクトを配列へ追加
    storeOwnSmsCache.push({
        delivery_month: new Date().toISOString().substring(0, 7),
        store_code: storesCache[0]?.store_code || "unknown",
        category: "オイル",
        sms_count: 0
    });

    loadStoreSmsGrid();
}

// 店舗独自SMS変更保存
async function saveStoreSmsGrid() {
    const rows = document.querySelectorAll('.sms-grid-row');
    const updates = [];

    rows.forEach(row => {
        const month = row.querySelector('.sms-month-input').value.trim();
        const storeCode = row.querySelector('.sms-store-input').value;
        const category = row.querySelector('.sms-category-input').value;
        const count = parseInt(row.querySelector('.sms-count-input').value) || 0;

        if (month) {
            updates.push({
                delivery_month: month,
                store_code: storeCode,
                category: category,
                sms_count: count
            });
        }
    });

    if (!supabaseClient) {
        storeOwnSmsCache = updates;
        showToast("💾 店舗独自SMS数を一時保存しました（デモ）。", "success");
        loadAllData();
        return;
    }

    try {
        // 先に既存の店舗独自SMSデータを削除するか、upsertを使用
        // unique制約(delivery_month, store_code, category)をSQLで貼っているためupsertでOK
        const { error } = await supabaseClient.from('store_own_sms').upsert(updates);
        if (error) throw error;

        showToast("💾 店舗独自SMSの登録が完了しました！", "success");
        await loadInitialData();
    } catch (err) {
        console.error(err);
        showToast("❌ データの保存に失敗しました。", "error");
    }
}

// 10. トーストヘルパー

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const msgEl = document.getElementById('toast-message');

    // クラスリセット
    toast.className = 'toast';
    
    if (type === 'success') {
        toast.classList.add('toast-success');
        icon.innerText = "✅";
    } else if (type === 'error') {
        toast.classList.add('toast-error');
        icon.innerText = "❌";
    } else if (type === 'warning') {
        toast.classList.add('toast-warning');
        icon.innerText = "⚠️";
    } else {
        icon.innerText = "ℹ️";
    }

    msgEl.innerText = message;
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3500);
}

// 10.5. カスタム確認ダイアログヘルパー
function showCustomConfirm(title, message, isDanger = true) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const msgEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');
        
        if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) {
            resolve(confirm(message));
            return;
        }
        
        titleEl.innerHTML = `⚠️ ${title}`;
        msgEl.innerHTML = message;
        
        if (isDanger) {
            okBtn.className = 'btn btn-danger';
        } else {
            okBtn.className = 'btn btn-primary';
        }
        
        modal.style.display = 'flex';
        
        const cleanup = () => {
            modal.style.display = 'none';
            okBtn.onclick = null;
            cancelBtn.onclick = null;
        };
        
        okBtn.onclick = () => {
            cleanup();
            resolve(true);
        };
        
        cancelBtn.onclick = () => {
            cleanup();
            resolve(false);
        };
    });
}

// 📅 その月の全スケジュール（子レコードもろとも）と配信月アコーディオン枠を丸ごと一括削除する
async function deleteMonthlyCampaigns(month) {
    const [year, monthVal] = month.split('-');
    const displayMonth = `${year}年${monthVal}月`;
    
    const ok = await showCustomConfirm(
        "配信月グループの削除",
        `【${displayMonth}】の配信月グループを丸ごと削除しますか？<br><br><span style="color: var(--danger); font-weight: bold;">⚠️ 警告：</span>アコーディオン枠自体と、中に登録されているすべてのスケジュール行、および紐づく送信実績CSVデータが**丸ごと完全に消去**されます。この操作は取り消せません。`
    );
    if (!ok) return;
    
    // 1. アコーディオンの仮キャッシュと下書き状態を完全に消去
    if (accordionDraftStates[month]) {
        delete accordionDraftStates[month];
    }
    if (activeGridAccordions.has(month)) {
        activeGridAccordions.delete(month);
    }
    if (justAddedAccordion === month) {
        justAddedAccordion = null;
    }
    
    if (!supabaseClient) {
        // デモ環境
        const campsInMonth = campaignsCache.filter(c => 
            c.drawMonth === month || (c.delivery_date && c.delivery_date.startsWith(month))
        );
        const ids = campsInMonth.map(c => c.id);
        
        campaignsCache = campaignsCache.filter(c => !ids.includes(c.id));
        smsDeliveriesCache = smsDeliveriesCache.filter(d => !ids.includes(d.campaign_id));
        
        renderCampaignGrid();
        loadAllData();
        return;
    }
    
    try {
        // campaigns テーブルの delivery_date は DATE 型のため、LIKE 検索は型エラー（PostgreSQLで date LIKE text の演算子エラー）を引き起こします。
        // そのため、その月の初日から末日までの日付による範囲指定（gte と lte）で安全に削除を実行します。
        const [year, monthVal] = month.split('-').map(Number);
        const startDate = `${month}-01`;
        const lastDay = new Date(year, monthVal, 0).getDate();
        const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

        const { error } = await supabaseClient
            .from('campaigns')
            .delete()
            .gte('delivery_date', startDate)
            .lte('delivery_date', endDate);
            
        if (error) throw error;
        
        await loadInitialData();
        renderCampaignGrid();
    } catch (err) {
        console.error(err);
        showToast("❌ 配信月グループの削除に失敗しました。", "error");
    }
}

// 11. キャンペーン（親）スプレッドシート型グリッドおよび月別アコーディオンUI制御関数

// アコーディオンの開閉状態を保持するセット
let activeGridAccordions = new Set();

// 📅 アコーディオンごとの入力中（未確定）の年・月の下書き状態を保持するオブジェクト
let accordionDraftStates = {};

// 📅 描画用の一時配信月キー (drawMonth) を初期設定する関数 (保存まで位置をその場に留めるため)
function initializeDrawMonths() {
    campaignsCache.forEach(c => {
        if (!c.drawMonth) {
            if (c.delivery_date) {
                const parts = c.delivery_date.split('-');
                c.drawMonth = `${parts[0]}-${parts[1]}`;
            } else {
                c.drawMonth = "未設定";
            }
        }
    });
}

// 📅 新しく追加され、未保存の配信月キーをピン留め保持する変数
let justAddedAccordion = null;

// 📅 日付プレフィックス安全更新関数 (元の名前を一切書き換えずに先頭のYYYYMMDD部分のみ差し替え)
function updateCampaignNameDatePrefix(currentName, newDate) {
    if (!currentName) currentName = "";
    if (!newDate) return currentName;
    const newPrefix = newDate.replace(/-/g, "").substring(0, 8); // "YYYYMMDD"
    const prefixRegex = /^(\d{8})[\s_]+/;
    
    if (prefixRegex.test(currentName)) {
        return currentName.replace(prefixRegex, `${newPrefix} `);
    } else {
        return `${newPrefix} ${currentName}`;
    }
}

// アコーディオンの開閉トグル
function toggleGridAccordion(month) {
    const item = document.getElementById(`accordion-item-${month}`);
    if (!item) return;

    if (activeGridAccordions.has(month)) {
        activeGridAccordions.delete(month);
        item.classList.remove('open');
    } else {
        activeGridAccordions.add(month);
        item.classList.add('open');
    }
}

// 📅 アコーディオンヘッダーの年月変更をハンドルし、そのグループの全スケジュールの日付を一括更新
function handleAccordionMonthChange(oldMonth, newYear, newMonth) {
    if (!oldMonth || oldMonth === '未設定') return;
    
    // 下書き状態の初期化
    if (!accordionDraftStates[oldMonth]) {
        const [oldYear, oldMonthVal] = oldMonth.split('-');
        accordionDraftStates[oldMonth] = {
            year: oldYear || null,
            month: oldMonthVal || null
        };
    }
    
    const draft = accordionDraftStates[oldMonth];
    
    // 選択された値（年または月）を下書き状態に反映
    if (newYear !== null) {
        draft.year = newYear || null; // 空文字の場合は未選択(null)
    }
    if (newMonth !== null) {
        draft.month = newMonth || null; // 空文字の場合は未選択(null)
    }
    
    // ⚠️ 年と月の両方が明示的に選択されている場合のみ、実際の一括更新処理を実行する
    if (draft.year && draft.month) {
        const newMonthStr = `${draft.year}-${draft.month}`;
        
        if (oldMonth !== newMonthStr) {
            let updatedCount = 0;
            campaignsCache.forEach(c => {
                const isTarget = c.drawMonth === oldMonth || (c.delivery_date && c.delivery_date.startsWith(oldMonth));
                if (isTarget) {
                    const dayPart = (c.delivery_date && c.delivery_date.split('-')[2]) || '22'; // 日が無い場合はデフォルト22日
                    const newDate = `${newMonthStr}-${dayPart}`;
                    c.delivery_date = newDate;
                    
                    // 元の名前を一切書き換えずに先頭のYYYYMMDD部分のみ差し替え
                    c.campaign_name = updateCampaignNameDatePrefix(c.campaign_name, c.delivery_date);
                    
                    // アコーディオンの描画キーも新しいキーに移行
                    c.drawMonth = newMonthStr;
                    
                    updatedCount++;
                }
            });
            
            // 下書き状態のキー自体も新しい年月キーに移行（リネーム）する
            accordionDraftStates[newMonthStr] = {
                year: draft.year,
                month: draft.month
            };
            delete accordionDraftStates[oldMonth];

            // アコーディオンの開閉状態（activeGridAccordions）のキーも移行する
            if (activeGridAccordions.has(oldMonth)) {
                activeGridAccordions.delete(oldMonth);
                activeGridAccordions.add(newMonthStr);
            }

            // ピン留めキー（justAddedAccordion）の移行
            if (justAddedAccordion === oldMonth) {
                justAddedAccordion = newMonthStr;
            }
        }
    }
    
    // 再描画
    renderCampaignGrid();
}

// 📅 その月に定期配信スケジュール10本を一括自動作成する (重複自動回避マージ付き)
// 日本の祝日データ (2025〜2027年)
const JAPAN_HOLIDAYS = new Set([
    // 2025
    "2025-01-01", "2025-01-13", "2025-02-11", "2025-02-23", "2025-02-24", "2025-03-20", "2025-04-29",
    "2025-05-03", "2025-05-04", "2025-05-05", "2025-05-06", "2025-07-21", "2025-08-11", "2025-09-15",
    "2025-09-23", "2025-10-13", "2025-11-03", "2025-11-23", "2025-11-24",
    // 2026
    "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03",
    "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22",
    "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-23",
    // 2027
    "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29",
    "2027-05-03", "2027-05-04", "2027-05-05", "2027-05-06", "2027-07-19", "2027-08-11", "2027-09-20",
    "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23"
]);

// 土日祝日を判定し、平日に後倒しする関数
function getNextWorkDay(dateStr) {
    const parts = dateStr.split('-');
    const y = parseInt(parts[0]);
    const m = parseInt(parts[1]) - 1; // 0-indexed
    const d = parseInt(parts[2]);
    
    let date = new Date(y, m, d);
    if (isNaN(date.getTime())) {
        return dateStr;
    }
    
    let iterations = 0;
    while (iterations < 45) { // 最長で45日間後倒し（念のための上限設定）
        iterations++;
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const key = `${yyyy}-${mm}-${dd}`;
        
        const day = date.getDay(); // 0:日, 6:土
        const isWeekend = (day === 0 || day === 6);
        const isHoliday = JAPAN_HOLIDAYS.has(key);
        
        if (isWeekend || isHoliday) {
            // 土日祝日なので1日進める（後倒し）
            date.setDate(date.getDate() + 1);
        } else {
            // 平日なので確定
            return `${yyyy}-${mm}-${dd}`;
        }
    }
    return dateStr;
}

// 📝 キャンペーン名の自動生成共通関数 ([8桁日付] [大分類] [基準] [タイミング] [前/後] [suffix])
function generateCampaignName(date, category, criteria, timing, before_after, currentName = "") {
    const datePrefix = date ? date.replace(/-/g, "").substring(0, 8) : "";
    
    let nameParts = [];
    if (category && category !== 'なし') nameParts.push(category);
    if (criteria && criteria !== 'なし') nameParts.push(criteria);
    if (timing && timing !== 'なし') nameParts.push(timing);
    if (before_after && before_after !== 'なし') nameParts.push(before_after);
    
    let suffix = "";
    if (currentName) {
        if (currentName.includes("新規")) suffix = "新規";
        else if (currentName.includes("リピート")) suffix = "リピート";
        else if (currentName.includes("オイル1")) suffix = "オイル1";
        else if (currentName.includes("オイル2")) suffix = "オイル2";
    }
    
    const baseName = nameParts.length > 0 ? nameParts.join(" ") : "無題の配信";
    return `${datePrefix}${datePrefix ? ' ' : ''}${baseName}${suffix ? ' ' + suffix : ''}`;
}

// 📝 リアルタイム同期用のハンドラー群 (再描画時に手入力値が消えるのを防ぐ)
function handleGridCountChange(e, id) {
    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    if (campaign) {
        campaign.sent_count_report = parseInt(e.target.value) || 0;
    }
}

function handleGridCategoryChange(e, id) {
    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    if (campaign) {
        campaign.category = e.target.value;
    }
}

function handleGridCriteriaChange(e, id) {
    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    if (campaign) {
        campaign.criteria = e.target.value;
    }
}

function handleGridTimingChange(e, id) {
    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    if (campaign) {
        campaign.timing = e.target.value;
    }
}

function handleGridBeforeAfterChange(e, id) {
    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    if (campaign) {
        campaign.before_after = e.target.value;
    }
}

function handleGridWorkGroupChange(e, id) {
    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    if (campaign) {
        campaign.work_group = e.target.value.trim();
    }
}

// 予約される作業の作業種別IDをリアルタイム同期するハンドラー [新規追加]
function handleGridWorkTypeIdChange(e, id) {
    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    if (campaign) {
        campaign.work_type_id = e.target.value.trim();
    }
}

// グリッド内の日付変更をリアルタイム同期（保存前でもアコーディオン月が正しく切り替わる）
function handleGridDateChange(e, id) {
    const newDate = e.target.value;
    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    if (campaign && newDate) {
        campaign.delivery_date = newDate;
        
        // 元の名前を一切書き換えずに先頭のYYYYMMDD部分のみ差し替え
        campaign.campaign_name = updateCampaignNameDatePrefix(campaign.campaign_name, campaign.delivery_date);
        
        // 配信月が変わった場合、移動先のアコーディオンを展開状態にセット（保存後の再描画で開くようにする）
        if (newDate) {
            const dateParts = newDate.split('-');
            if (dateParts.length >= 2) {
                const newMonth = `${dateParts[0]}-${dateParts[1]}`;
                activeGridAccordions.add(newMonth);
            }
        }
        
        // 日付修正時のソート・再描画（入力途中での行移動）を防ぐため、ここでは renderCampaignGrid() の呼び出しを廃止します。
        // 右上の「保存」ボタン押下時に一括ソートされ再整列されます。
    }
}

// 📅 その月に定期配信スケジュール10本を一括自動作成する (重複自動回避マージ付き)
function createMonthly10Campaigns(targetMonth, drawMonthKey) {
    if (!targetMonth || targetMonth === '未設定') {
        showToast("❌ 有効な月が判定できませんでした。", "error");
        return;
    }

    // ★ ユーザー体験向上: 新規追加した中身の無い初期行（仮行）があれば、自動クリーンアップする (日付プレフィックス付きも確実に検出)
    const initialRows = campaignsCache.filter(c => 
        c.delivery_date && c.delivery_date.startsWith(targetMonth) &&
        (
            c.campaign_name === "新規配信スケジュール" || 
            c.campaign_name === "無題の配信" || 
            c.campaign_name.includes("新規配信スケジュール") ||
            c.campaign_name.includes("無題 of 配信") ||
            c.campaign_name.includes("無題の配信")
        )
    );
    
    if (initialRows.length > 0) {
        const initialIds = initialRows.map(r => r.id);
        campaignsCache = campaignsCache.filter(c => !initialIds.includes(c.id));
    }

    const [year, month] = targetMonth.split('-');
    
    // 候補日（車検は12日、オイル・コーティングは22日）を算出し、土日祝を避けて後倒し
    const deliveryDate12 = getNextWorkDay(`${year}-${month}-12`);
    const deliveryDate22 = getNextWorkDay(`${year}-${month}-22`);
    
    const datePrefix12 = deliveryDate12.replace(/-/g, "");
    const datePrefix22 = deliveryDate22.replace(/-/g, "");

    // 定期配信10本の設定テンプレート (作業種別ID work_type_id を付与)
    const templates = [
        { date: deliveryDate12, category: "車検", criteria: "満了日", timing: "2ヶ月", before_after: "前", work_group: "事前点検", work_type_id: "11755", name: `${datePrefix12} 車検2ヶ月前` },
        { date: deliveryDate12, category: "車検", criteria: "満了日", timing: "4ヶ月", before_after: "前", work_group: "事前点検", work_type_id: "11755", name: `${datePrefix12} 車検4ヶ月前リピート` },
        { date: deliveryDate12, category: "車検", criteria: "満了日", timing: "4ヶ月", before_after: "前", work_group: "事前点検", work_type_id: "11755", name: `${datePrefix12} 車検4ヶ月前新規` },
        { date: deliveryDate12, category: "車検", criteria: "満了日", timing: "6ヶ月", before_after: "前", work_group: "事前点検", work_type_id: "11755", name: `${datePrefix12} 車検6ヶ月前` },
        { date: deliveryDate12, category: "車検", criteria: "満了日", timing: "12ヶ月", before_after: "前", work_group: "12ヶ月点検", work_type_id: "11760", name: `${datePrefix12} 車検12ヶ月前` },
        { date: deliveryDate12, category: "車検", criteria: "満了日", timing: "18ヶ月", before_after: "前", work_group: "6ケ月点検", work_type_id: "11759", name: `${datePrefix12} 車検18ヶ月前` },
        { date: deliveryDate22, category: "オイル", criteria: "実施日", timing: "5ヶ月", before_after: "後", work_group: "オイル交換", work_type_id: "11762", name: `${datePrefix22} オイル1` },
        { date: deliveryDate22, category: "オイル", criteria: "実施日", timing: "6ヶ月", before_after: "後", work_group: "オイル交換", work_type_id: "11762", name: `${datePrefix22} オイル2` },
        { date: deliveryDate22, category: "コーティング", criteria: "実施日", timing: "1ヶ月", before_after: "後", work_group: "コーティング無料点検", work_type_id: "17113", name: `${datePrefix22} コーティング1ヶ月後` },
        { date: deliveryDate22, category: "コーティング", criteria: "実施日", timing: "11ヶ月", before_after: "後", work_group: "コーティング無料点検", work_type_id: "17113", name: `${datePrefix22} コーティング11ヶ月後` }
    ];

    let addedCount = 0;
    templates.forEach(t => {
        // インテリジェント重複排除：大分類、タイミング、前後がすでに月内に存在するかチェック
        // (オイル系はファイル名も考慮して重複を完全に回避)
        const exists = campaignsCache.some(c => 
            c.delivery_date && c.delivery_date.startsWith(targetMonth) &&
            c.category === t.category &&
            c.timing === t.timing &&
            c.before_after === t.before_after &&
            ( (t.category !== "オイル" && !t.name.includes("4ヶ月前")) || c.campaign_name === t.name )
        );

        if (!exists) {
            campaignsCache.push({
                id: "camp_" + Math.random().toString(36).substr(2, 9),
                delivery_date: t.date,
                category: t.category,
                sent_count_report: 0,
                criteria: t.criteria,
                timing: t.timing,
                before_after: t.before_after,
                work_group: t.work_group,
                work_type_id: t.work_type_id || "", // 作業種別IDを追加
                campaign_name: t.name,
                drawMonth: drawMonthKey || targetMonth
            });
            addedCount++;
        }
    });

    renderCampaignGrid();
}

// 📅 その月に手動でスケジュールを1行追加する
function addSingleCampaignRow(targetMonth, drawMonthKey) {
    if (!targetMonth || targetMonth === '未設定') {
        showToast("❌ 有効な月が判定できませんでした。", "error");
        return;
    }

    const [year, month] = targetMonth.split('-');
    // デフォルト日付は22日とする
    const defaultDate = getNextWorkDay(`${year}-${month}-22`);
    
    // 一時IDを生成
    const tempId = "camp_" + Math.random().toString(36).substr(2, 9);
    
    campaignsCache.push({
        id: tempId,
        delivery_date: defaultDate,
        category: "なし",
        sent_count_report: 0,
        criteria: "なし",
        timing: "なし",
        before_after: "なし",
        work_group: "",
        work_type_id: "",
        campaign_name: "新規配信スケジュール",
        drawMonth: drawMonthKey || targetMonth
    });

    // 追加したアコーディオンを展開状態にする
    activeGridAccordions.add(drawMonthKey || targetMonth);

    renderCampaignGrid();
}

// 配信スケジュールグリッド（アコーディオン形式）の描画

function renderCampaignGrid() {
    const container = document.getElementById('campaign-accordion-container');
    if (!container) return;

    container.innerHTML = '';
    // ⚠️ キャッシュも下書きも両方空の場合のみ登録なしメッセージを表示
    if (campaignsCache.length === 0 && Object.keys(accordionDraftStates).length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px !important;">スケジュールが登録されていません。「1行追加」から作成してください。</div>';
        return;
    }

    // 1. 配信月ごとにキャンペーンをグループ化 (YYYY-MM)
    const groups = {};
    campaignsCache.forEach(c => {
        let month = "未設定";
        if (c.drawMonth) {
            month = c.drawMonth;
        } else if (c.delivery_date) {
            const dateParts = c.delivery_date.split('-');
            if (dateParts.length >= 2) {
                month = `${dateParts[0]}-${dateParts[1]}`;
            }
        }
        if (!groups[month]) {
            groups[month] = [];
        }
        groups[month].push(c);
    });

    // 📅 accordionDraftStates に登録されている下書き中の空グループもマージする（子レコード0件からスタートするため）
    Object.keys(accordionDraftStates).forEach(monthStr => {
        if (monthStr !== '未設定' && !groups[monthStr]) {
            groups[monthStr] = []; // 空の配列でグループ枠を作成
        }
    });

    // 月の降順でソート (未設定は最後に配置、新規追加された月は一時的に最上部に固定)
    const sortedMonths = Object.keys(groups).sort((a, b) => {
        if (a === justAddedAccordion) return -1;
        if (b === justAddedAccordion) return 1;
        if (a === '未設定') return 1;
        if (b === '未設定') return -1;
        return b.localeCompare(a);
    });

    // 2. 各月ごとのアコーディオンを描画
    sortedMonths.forEach((month, idx) => {
        const list = groups[month];
        
        // 配信日の昇順でソート（同じ日付の場合は大分類、タイミング、名前で一意にソートしてねじれを完全に防止）
        list.sort((a, b) => {
            const dateA = new Date(a.delivery_date || '9999-12-31');
            const dateB = new Date(b.delivery_date || '9999-12-31');
            if (dateA - dateB !== 0) return dateA - dateB;

            const categoryOrder = { "車検": 1, "点検": 2, "コーティング": 3, "オイル": 4, "洗車": 5, "なし": 6 };
            const catA = categoryOrder[a.category] || 99;
            const catB = categoryOrder[b.category] || 99;
            if (catA - catB !== 0) return catA - catB;

            const timingOrder = { "1ヶ月": 1, "2ヶ月": 2, "4ヶ月": 3, "5ヶ月": 4, "6ヶ月": 5, "11ヶ月": 6, "12ヶ月": 7, "18ヶ月": 8, "なし": 9 };
            const timeA = timingOrder[a.timing] || 99;
            const timeB = timingOrder[b.timing] || 99;
            if (timeA - timeB !== 0) return timeA - timeB;

            return String(a.campaign_name).localeCompare(String(b.campaign_name));
        });

        // アップロード状況（し忘れ防止チェック用）の集計
        const total = list.length;
        let uploadedCount = 0;
        list.forEach(c => {
            const actualDeliveries = smsDeliveriesCache.filter(d => d.campaign_id === c.id);
            const actualCount = actualDeliveries.length; // 通数合計ではなく「送信宛先件数（顧客数）」をカウント！
            if (actualCount > 0) {
                uploadedCount++;
            }
        });

        // デフォルトはすべて閉じた状態を標準とし、過去に開く操作をした月のみ開く
        const isOpen = activeGridAccordions.has(month);
        if (isOpen) {
            activeGridAccordions.add(month);
        }

        const isCompleted = uploadedCount === total;
        const badgeClass = isCompleted ? 'badge-success' : 'badge-warning';
        const badgeLabel = isCompleted 
            ? `🟢 完了 (${total}/${total}件完了)` 
            : `⚠️ 未完了 (残り ${total - uploadedCount}件 / ${uploadedCount}/${total}件完了)`;

        const [currentYear, currentMonth] = month !== '未設定' ? month.split('-') : [null, null];
        
        // 全て仮行（新規追加されたばかりのグループ）であるか判定
        const isAllTemp = list.every(c => c.campaign_name === "新規配信スケジュール" || c.campaign_name === "無題の配信" || c.campaign_name === "無題 of 配信");

        // 今日追加されたばかりのまっさらな初期状態であるか判定 (年・月が今日の年月と一致するか)
        const now = new Date();
        const todayYear = String(now.getFullYear());
        const todayMonth = String(now.getMonth() + 1).padStart(2, '0');
        const isInitialFresh = isAllTemp && (currentYear === todayYear && currentMonth === todayMonth);

        // 📅 アコーディオンの下書き状態を取得または初期化
        if (month !== '未設定' && !accordionDraftStates[month]) {
            accordionDraftStates[month] = {
                year: isInitialFresh ? null : currentYear,
                month: isInitialFresh ? null : currentMonth
            };
        }
        const draft = accordionDraftStates[month] || { year: null, month: null };

        // まっさらな初期状態、またはユーザーが下書きで空（null）にしている場合は空欄を選択
        const yearOptions = currentYear ? getDynamicYearOptions(draft.year, false) : "";
        
        let monthOptions = '';
        if (currentMonth) {
            for (let m = 1; m <= 12; m++) {
                const mStr = String(m).padStart(2, '0');
                const isSelected = (draft.month && mStr === draft.month) ? 'selected' : '';
                monthOptions += `<option value="${mStr}" ${isSelected}>${m}月</option>`;
            }
        }

        // 配信月ラベルの描画（下書き状態を基準に selected を制御）
        let headerTitleHtml = "";
        if (month === '未設定') {
            headerTitleHtml = `<span>📅 日付未設定</span>`;
        } else {
            headerTitleHtml = `
                <div class="accordion-month-selector-container" onclick="event.stopPropagation();" style="display: inline-flex; align-items: center; gap: 6px;">
                    📅 
                    <select class="accordion-month-select-v2" style="padding: 4px 8px; font-size: 12px; font-weight: 600; background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 4px; height: auto; width: auto;" onchange="handleAccordionMonthChange('${month}', this.value, null)">
                        <option value="" disabled ${!draft.year ? 'selected' : ''} hidden>-</option>
                        ${yearOptions}
                    </select>
                    <select class="accordion-month-select-v2" style="padding: 4px 8px; font-size: 12px; font-weight: 600; background: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 4px; height: auto; width: auto;" onchange="handleAccordionMonthChange('${month}', null, this.value)">
                        <option value="" disabled ${!draft.month ? 'selected' : ''} hidden>-</option>
                        ${monthOptions}
                    </select>
                </div>
            `;
        }

        // 10本一括自動作成ボタン ＆ 月スケジュールの一括削除ボタンの生成（元のシンプルな操作エリアに復元）
        let batchCreateButtonHtml = "";
        if (month !== '未設定') {
            const hasSchedules = total > 0;
            const canCreate = total < 10;
            
            // ★ アコーディオンの位置固定に伴い、一括作成に渡す年月は、ユーザーがヘッダーで選んだ最新の下書き状態を優先する
            const draft = accordionDraftStates[month] || { year: null, month: null };
            const currentMonthStr = (draft.year && draft.month) ? `${draft.year}-${draft.month}` : month;
            
            batchCreateButtonHtml = `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: rgba(59, 130, 246, 0.06); border-bottom: 1px solid var(--border-color);">
                    <span style="font-size: 12px; color: #93c5fd; font-weight: 500;">
                        ${canCreate ? '💡 この月に定期配信スケジュールを自動作成できます（車検6本・オイル2本・コーティング2本）' : '✨ この月のスケジュール一覧'}
                    </span>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-primary" style="padding: 6px 12px; font-size: 11px; height: auto; background-color: #3b82f6; border-color: #3b82f6;" onclick="addSingleCampaignRow('${currentMonthStr}', '${month}')">➕ 1行追加</button>
                        ${canCreate ? `<button class="btn btn-secondary" style="padding: 6px 12px; font-size: 11px; height: auto;" onclick="createMonthly10Campaigns('${currentMonthStr}', '${month}')">📦 この月に定期配信10本を一括作成</button>` : ''}
                        <button class="btn btn-outline-danger" style="padding: 6px 12px; font-size: 11px; height: auto;" onclick="deleteMonthlyCampaigns('${month}')">🗑️ この配信月グループを削除</button>
                    </div>
                </div>
            `;
        }

        let tableRowsHtml = "";
        list.forEach(c => {
            const actualDeliveries = smsDeliveriesCache.filter(d => d.campaign_id === c.id);
            const actualCount = actualDeliveries.length; // 通数合計ではなく「送信宛先件数（顧客数）」をカウント！

            // 🔍 デバッグ：キャンペーン行ごとのグリッド判定実績を詳細出力
            if (c.category === 'オイル') {
                logToConsole(`🔍 デバッグ(グリッド描画): [${c.delivery_date}] ${c.campaign_name} (ID: ${c.id}) ➡ 判定された実績: ${actualCount} 件`);
            }

            // 新規・リピートの判定とバッジおよび注記の生成
            let typeBadgeHtml = "";
            let suffixLabel = "";
            if (c.campaign_name) {
                if (c.campaign_name.includes("リピート")) {
                    typeBadgeHtml = `<span class="badge-type badge-repeat" style="display: inline-block; font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); font-weight: bold; margin-right: 6px; white-space: nowrap; pointer-events: none;">リピート</span>`;
                    suffixLabel = "（リピート用）";
                } else if (c.campaign_name.includes("新規")) {
                    typeBadgeHtml = `<span class="badge-type badge-new" style="display: inline-block; font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.2); color: #a7f3d0; border: 1px solid rgba(16, 185, 129, 0.4); font-weight: bold; margin-right: 6px; white-space: nowrap; pointer-events: none;">新規</span>`;
                    suffixLabel = "（新規用）";
                }
            }

            // 各種選択肢の構築
            const categoryOpts = ["車検", "点検", "コーティング", "オイル", "洗車", "なし"]
                .map(opt => `<option value="${opt}" ${c.category === opt ? 'selected' : ''}>${opt}</option>`).join('');

            const criteriaOpts = ["満了日", "実施日", "なし"]
                .map(opt => `<option value="${opt}" ${c.criteria === opt ? 'selected' : ''}>${opt}</option>`).join('');

            const timingOpts = ["1ヶ月", "2ヶ月", "4ヶ月", "5ヶ月", "6ヶ月", "11ヶ月", "12ヶ月", "18ヶ月", "なし"]
                .map(opt => `<option value="${opt}" ${c.timing === opt ? 'selected' : ''}>${opt}</option>`).join('');

            const beforeAfterOpts = ["前", "後", "なし"]
                .map(opt => `<option value="${opt}" ${c.before_after === opt ? 'selected' : ''}>${opt}</option>`).join('');

            // アップロードセルのHTML状態
            let uploadCellHtml = "";
            if (activeUploadingCampaignId === c.id) {
                uploadCellHtml = `<div class="grid-upload-cell uploading" id="upload-cell-${c.id}" 
                    style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; background: rgba(59, 130, 246, 0.15); color: #93c5fd; font-weight: 500; pointer-events: none;">
                    <span class="spinner-mini"></span> ⏳ インポート中...
                </div>`;
            } else if (actualCount > 0) {
                uploadCellHtml = `<div class="grid-upload-cell uploaded" id="upload-cell-${c.id}" 
                    ondragover="handleGridDragOver(event, '${c.id}')"
                    ondragleave="handleGridDragLeave(event, '${c.id}')"
                    ondrop="handleGridDrop(event, '${c.id}')"
                    style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; position: relative;">
                    <span onclick="triggerGridUpload('${c.id}')" style="cursor: pointer; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding-right: 46px; box-sizing: border-box;">✅ アップ済み (${actualCount.toLocaleString()} 件)${suffixLabel}</span>
                    <button class="btn btn-row-clear" onclick="event.stopPropagation(); deleteCampaignDeliveries('${c.id}')" style="position: absolute; right: 4px; padding: 2px 6px; font-size: 10px; line-height: 1.2; height: 20px; background: rgba(239, 68, 68, 0.25); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5; border-radius: 4px; z-index: 10; cursor: pointer; font-weight: 600;">クリア</button>
                </div>`;
            } else {
                uploadCellHtml = `<div class="grid-upload-cell" id="upload-cell-${c.id}" 
                    onclick="triggerGridUpload('${c.id}')"
                    ondragover="handleGridDragOver(event, '${c.id}')"
                    ondragleave="handleGridDragLeave(event, '${c.id}')"
                    ondrop="handleGridDrop(event, '${c.id}')"
                    style="width: 100%; height: 100%;">ここにCSVをアップロード${suffixLabel}</div>`;
            }

            tableRowsHtml += `
                <tr class="campaign-grid-row" data-id="${c.id}">
                    <td style="padding: 0 !important;"><input type="date" class="grid-date" value="${c.delivery_date || ''}" onchange="handleGridDateChange(event, '${c.id}')"></td>
                    <td style="padding: 0 !important;"><input type="number" class="grid-report-count" value="${c.sent_count_report || 0}" min="0" style="text-align: right;" onchange="handleGridCountChange(event, '${c.id}')" oninput="handleGridCountChange(event, '${c.id}')"></td>
                    <td style="text-align: center; font-weight: 600; color: var(--text-muted);">${actualCount.toLocaleString()} 件</td>
                    <td style="padding: 0 !important;"><select class="grid-category" onchange="handleGridCategoryChange(event, '${c.id}')">${categoryOpts}</select></td>
                    <td style="padding: 0 !important;"><select class="grid-criteria" onchange="handleGridCategoryChange(event, '${c.id}')">${criteriaOpts}</select></td>
                    <td style="padding: 0 !important;"><select class="grid-timing" onchange="handleGridTimingChange(event, '${c.id}')">${timingOpts}</select></td>
                    <td style="padding: 0 !important;"><select class="grid-before-after" onchange="handleGridBeforeAfterChange(event, '${c.id}')">${beforeAfterOpts}</select></td>
                    <td style="padding: 0 !important;">
                        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; height: 100%;">
                            <input type="text" class="grid-workgroup" value="${c.work_group || ''}" placeholder="例: 事前点検" onchange="handleGridWorkGroupChange(event, '${c.id}')" oninput="handleGridWorkGroupChange(event, '${c.id}')" style="flex: 1; min-width: 0;">
                            ${typeBadgeHtml}
                        </div>
                    </td>
                    <td style="padding: 0 !important;"><input type="text" class="grid-worktypeid" value="${c.work_type_id || ''}" placeholder="例: 11755" style="text-align: center; font-family: monospace;" onchange="handleGridWorkTypeIdChange(event, '${c.id}')" oninput="handleGridWorkTypeIdChange(event, '${c.id}')"></td>
                    <td style="padding: 2px !important;">
                        ${uploadCellHtml}
                    </td>
                    <td style="text-align: center; padding: 4px !important;">
                        <button class="btn-grid-delete" title="削除" onclick="deleteCampaignGridRow('${c.id}')">
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 6h18"/>
                                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                <line x1="10" x2="10" y1="11" y2="17"/>
                                <line x1="14" x2="14" y1="11" y2="17"/>
                            </svg>
                            削除
                        </button>
                    </td>
                </tr>
            `;
        });

        // 子レコードが空欄（0件）の場合とデータがある場合でテーブル描画を切り替える
        let contentBodyHtml = "";
        if (total > 0) {
            contentBodyHtml = `
                <table class="spreadsheet-table">
                    <thead>
                        <tr>
                            <th style="min-width: 130px; text-align: center;">配信日付</th>
                            <th style="min-width: 90px; text-align: center;">対象件数</th>
                            <th style="min-width: 90px; text-align: center;"># 配信完了数</th>
                            <th style="min-width: 105px; text-align: center;">大分類</th>
                            <th style="min-width: 100px; text-align: center;">基準</th>
                            <th style="min-width: 100px; text-align: center;">タイミング</th>
                            <th style="min-width: 80px; text-align: center;">前/後</th>
                            <th style="min-width: 160px; text-align: center;">予約される作業</th>
                            <th style="min-width: 90px; text-align: center;">作業種別ID</th>
                            <th style="min-width: 230px; text-align: center;">配信結果</th>
                            <th style="min-width: 80px; text-align: center;">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRowsHtml}
                    </tbody>
                </table>
            `;
        } else {
            contentBodyHtml = `
                <div style="text-align: center; color: var(--text-muted); padding: 30px !important; font-size: 13px; background: var(--bg-dark); border-top: 1px solid var(--border-color);">
                    💡 この配信月グループにはまだスケジュールが登録されていません。<br>
                    上の<b>「定期配信10本を一括作成」</b>ボタンを押すと、自動的に10件のスケジュールが生成されます。
                </div>
            `;
        }

        container.innerHTML += `
            <div class="grid-accordion-item ${isOpen ? 'open' : ''}" id="accordion-item-${month}">
                <div class="grid-accordion-header" onclick="toggleGridAccordion('${month}')">
                    <div class="grid-accordion-title">
                        <span class="grid-accordion-arrow" style="margin-right: 8px;">▶</span>
                        ${headerTitleHtml}
                        <span style="font-size: 12px; color: var(--text-muted); font-weight: normal; margin-left: 6px;">(${total}件のスケジュール)</span>
                    </div>
                    <div class="grid-accordion-meta">
                        <div class="grid-accordion-badge ${badgeClass}">${badgeLabel}</div>
                    </div>
                </div>
                <div class="grid-accordion-content" style="padding: 0 !important;">
                    ${batchCreateButtonHtml}
                    ${contentBodyHtml}
                </div>
            </div>
        `;
    });
}
// 📅 新規の配信月グループ（アコーディオン枠）を追加する関数 (10本一括作成を押すまで子レコードは一切生成しない)
function addCampaignGridRow() {
    const now = new Date();
    let checkYear = now.getFullYear();
    let checkMonth = now.getMonth() + 1; // 1-indexed
    
    let targetMonthStr = "";
    while (true) {
        const yStr = String(checkYear);
        const mStr = String(checkMonth).padStart(2, '0');
        const tempMonthStr = `${yStr}-${mStr}`;
        
        // campaignsCache にその年月が存在するかチェック
        const hasCampaigns = campaignsCache.some(c => 
            c.delivery_date && c.delivery_date.startsWith(tempMonthStr)
        );
        
        // accordionDraftStates にすでに下書きが存在するかチェック
        const hasDraft = accordionDraftStates[tempMonthStr] !== undefined;
        
        if (!hasCampaigns && !hasDraft) {
            targetMonthStr = tempMonthStr;
            break;
        }
        
        // すでに存在するので1ヶ月進める
        checkMonth++;
        if (checkMonth > 12) {
            checkMonth = 1;
            checkYear++;
        }
    }
    
    // 空いている仮の月で下書き状態を初期化 (初期表示は完全に空欄 [ - ] [ - ] にするため null)
    accordionDraftStates[targetMonthStr] = {
        year: null,
        month: null
    };
    
    // ピン留めキーに設定して最上部に固定する
    justAddedAccordion = targetMonthStr;
    
    // ⚠️ ユーザーの手順・意識を「配信年月ラベルの修正」に集中させるため、新規追加時はアコーディオンは閉じた状態にします
    if (activeGridAccordions.has(targetMonthStr)) {
        activeGridAccordions.delete(targetMonthStr);
    }
    
    renderCampaignGrid();
}

// スケジュール行の削除
async function deleteCampaignGridRow(id) {
    // 💡 セッション有効性チェック
    const isSessionValid = await checkAdminSession();
    if (!isSessionValid) return;

    const campaign = campaignsCache.find(c => String(c.id) === String(id));
    const displayName = campaign?.campaign_name || "この配信スケジュール";
    
    const ok = await showCustomConfirm(
        "スケジュールの削除",
        `【${displayName}】を削除しますか？<br><br><span style="color: var(--danger); font-weight: bold;">⚠️ 警告：</span>削除すると、この枠に紐づく送信実績CSVデータもすべて消去されます。この操作は取り消せません。`
    );
    if (!ok) return;

    if (!supabaseClient) {
        // デモ環境
        campaignsCache = campaignsCache.filter(c => String(c.id) !== String(id));
        smsDeliveriesCache = smsDeliveriesCache.filter(d => String(d.campaign_id) !== String(id));
        showToast("🗑️ スケジュールを削除しました（デモ）。", "success");
        renderCampaignGrid();
        loadAllData();
        return;
    }

    try {
        const { error } = await supabaseClient.from('campaigns').delete().eq('id', id);
        if (error) throw error;

        showToast("🗑️ スケジュールを削除しました。", "success");
        await loadInitialData();
    } catch (err) {
        console.error(err);
        showToast("❌ スケジュールの削除に失敗しました。", "error");
    }
}

// アップロードされた配信結果（子レコード）のみを削除する機能
async function deleteCampaignDeliveries(campaignId) {
    // 💡 セッション有効性チェック
    const isSessionValid = await checkAdminSession();
    if (!isSessionValid) return;

    const campaign = campaignsCache.find(c => String(c.id) === String(campaignId));
    const displayName = campaign?.campaign_name || "この配信";
    
    const ok = await showCustomConfirm(
        "配信結果のクリア",
        `【${displayName}】に登録されている送信実績CSVデータ（子レコード）のみをクリアしますか？<br>スケジュール行自体は削除されません。この操作は取り消せません。`
    );
    if (!ok) return;

    if (!supabaseClient) {
        // デモ環境
        smsDeliveriesCache = smsDeliveriesCache.filter(d => String(d.campaign_id) !== String(campaignId));
        showToast("🧹 送信実績を削除しました（デモ）。", "success");
        renderCampaignGrid();
        loadAllData();
        return;
    }

    try {
        const { error } = await supabaseClient.from('sms_deliveries').delete().eq('campaign_id', campaignId);
        if (error) throw error;

        // キャッシュからも削除
        smsDeliveriesCache = smsDeliveriesCache.filter(d => String(d.campaign_id) !== String(campaignId));

        showToast("🧹 送信実績データをクリアしました。", "success");
        renderCampaignGrid();
        loadAllData();
    } catch (err) {
        console.error(err);
        showToast("❌ 送信実績のクリアに失敗しました。", "error");
    }
}

// スケジュールグリッドの一括保存 (isSilent = true の場合はUIの表示・トーストを変更せずに静かに実行)
async function saveCampaignGrid(isSilent = false) {
    // 💡 セッション有効性チェック
    const isSessionValid = await checkAdminSession();
    if (!isSessionValid) return;

    const btn = document.getElementById('save-campaign-btn');
    const originalText = btn ? btn.innerHTML : "💾 編集内容を保存";
    const originalBg = btn ? btn.style.background : "";
    
    // ボタンをローディング状態にする
    if (btn && !isSilent) {
        btn.disabled = true;
        btn.innerHTML = "⏳ 保存中...";
        btn.style.opacity = "0.7";
    }

    const rows = document.querySelectorAll('.campaign-grid-row');
    const updates = [];

    rows.forEach(row => {
        const id = row.dataset.id;
        const delivery_date = row.querySelector('.grid-date').value;
        const sent_count_report = parseInt(row.querySelector('.grid-report-count').value) || 0;
        const category = row.querySelector('.grid-category').value;
        const criteria = row.querySelector('.grid-criteria').value;
        const timing = row.querySelector('.grid-timing').value;
        const before_after = row.querySelector('.grid-before-after').value;
        const work_group = row.querySelector('.grid-workgroup').value.trim();
        const work_type_id = row.querySelector('.grid-worktypeid').value.trim(); // [新規追加]

        // 既存キャッシュからsuffixを含む現在の名前を渡す
        const existingCampaign = campaignsCache.find(c => c.id === id);
        const currentName = existingCampaign ? existingCampaign.campaign_name : "新規配信スケジュール";

        // 勝手に自動組み立て名に書き換えせず、元の名前を維持して日付プレフィックスのみ更新する！
        const campaign_name = updateCampaignNameDatePrefix(currentName, delivery_date);

        let targetId = id;
        if (id && id.startsWith('camp_')) {
            // 新しいUUIDを生成して割り当てる
            const newUuid = generateUUID();
            targetId = newUuid;
            
            // campaignsCache の該当行の ID もその実UUIDに書き換えて同期する
            if (existingCampaign) {
                existingCampaign.id = newUuid;
            }
            // また、行要素のデータ属性（dataset.id）も書き換える
            row.dataset.id = newUuid;
        }

        const updateObj = {
            id: targetId,
            delivery_date: delivery_date || new Date().toISOString().split('T')[0],
            sent_count_report: sent_count_report,
            category: category,
            criteria: criteria,
            timing: timing,
            before_after: before_after,
            work_group: work_group,
            work_type_id: work_type_id, // [新規追加]
            campaign_name: campaign_name
        };

        updates.push(updateObj);
    });

    // 💡 下書き枠の整理や自動整列の一元化ヘルパー
    const finalizeSavedGridState = () => {
        justAddedAccordion = null;
        Object.keys(accordionDraftStates).forEach(monthKey => {
            const hasRealCampaigns = campaignsCache.some(c => 
                String(c.drawMonth) === String(monthKey) || (c.delivery_date && c.delivery_date.startsWith(monthKey))
            );
            if (hasRealCampaigns) {
                delete accordionDraftStates[monthKey];
            }
        });
        initializeDrawMonths(); // 描画用の配信月を最新の確定日にリフレッシュ
        renderCampaignGrid();
    };

    const restoreButton = (text, bgClassOrColor, duration) => {
        if (btn && !isSilent) {
            btn.innerHTML = text;
            btn.style.opacity = "1";
            btn.style.background = bgClassOrColor;
            btn.style.borderColor = bgClassOrColor;
            
            setTimeout(() => {
                btn.disabled = false;
                btn.innerHTML = originalText;
                btn.style.background = originalBg;
                btn.style.borderColor = "";
            }, duration);
        } else if (isSilent) {
            // サイレント時はボタンの見た目は変えず、状態のクリーンアップだけを実行
            Ct = null;
            Object.keys(accordionDraftStates).forEach(monthKey => {
                const hasRealCampaigns = campaignsCache.some(c => 
                    String(c.drawMonth) === String(monthKey) || (c.delivery_date && c.delivery_date.startsWith(monthKey))
                );
                if (hasRealCampaigns) {
                    delete accordionDraftStates[monthKey];
                }
            });
            Oc();
            Fe();
        }
    };

    if (!supabaseClient) {
        // デモ環境
        // キャッシュに存在するIDを維持しつつマージ
        campaignsCache = updates.map(u => {
            if (!u.id) {
                u.id = "camp_" + Math.random().toString(36).substr(2, 9);
            }
            return u;
        });
        
        // デモ環境用の drawMonth の強制再初期化
        campaignsCache.forEach(c => {
            if (c.delivery_date) {
                const parts = c.delivery_date.split('-');
                c.drawMonth = `${parts[0]}-${parts[1]}`;
            } else {
                c.drawMonth = "未設定";
            }
        });
        
        finalizeSavedGridState();
        restoreButton("✅ 保存完了！", "var(--secondary)", 1500);
        loadAllData();
        return;
    }

    try {
        const { error } = await supabaseClient.from('campaigns').upsert(updates);
        if (error) throw error;

        await loadInitialData(true); // 配信実績の再ロードをスキップして反映ラグによる表示消えを防止！
        finalizeSavedGridState(); // 即座に画面を実UUIDで再描画してタイムラグを解消！
        if (!isSilent) {
            restoreButton("✅ 保存完了！", "var(--secondary)", 1500);
        } else {
            restoreButton("", "", 0); // 状態のクリーンアップを実行
        }
    } catch (err) {
        console.error(err);
        if (!isSilent) {
            restoreButton("❌ 保存失敗", "var(--danger)", 2000);
        }
    }
}

// ファイル選択トリガー
let activeGridCampaignId = null;
function triggerGridUpload(campaignId) {
    if (campaignId && campaignId.startsWith('camp_')) {
        showToast("⚠️ まず右上の「スケジュールの変更を保存」ボタンを押してスケジュールを確定させてください。", "warning");
        return;
    }
    activeGridCampaignId = campaignId;
    document.getElementById('grid-file-input').click();
}

// グリッド内ファイル選択完了
function handleGridFileChange(event) {
    const files = event.target.files;
    if (files.length === 0 || !activeGridCampaignId) return;

    const file = files[0];
    processGridFile(file, activeGridCampaignId);
    event.target.value = ""; // リセット
}

// グリッド内ドラッグ＆ドロップ
function handleGridDragOver(e, id) {
    e.preventDefault();
    const cell = document.getElementById(`upload-cell-${id}`);
    if (cell) cell.classList.add('dragover');
}

// グリッド内ドラッグ＆ドロップの離脱
function handleGridDragLeave(e, id) {
    e.preventDefault();
    const cell = document.getElementById(`upload-cell-${id}`);
    if (cell) cell.classList.remove('dragover');
}

// グリッド内ドロップ
function handleGridDrop(e, id) {
    e.preventDefault();
    const cell = document.getElementById(`upload-cell-${id}`);
    if (cell) cell.classList.remove('dragover');

    if (id && id.startsWith('camp_')) {
        showToast("⚠️ まず右上の「スケジュールの変更を保存」ボタンを押してスケジュールを確定させてください。", "warning");
        return;
    }

    logToConsole(`📥 ドラッグ＆ドロップを検出しました (ID: ${id})`);

    const files = e.dataTransfer.files;
    if (files.length === 0) {
        logToConsole(`⚠️ 警告: ファイルが検出されませんでした。`);
        return;
    }

    processGridFile(files[0], id);
}

// グリッドCSVのパース・インポート
async function processGridFile(file, campaignId) {
    // 💡 セッション有効性チェック
    const isSessionValid = await checkAdminSession();
    if (!isSessionValid) {
        // 再ログイン後に自動再開するため、ファイル情報を一時保持
        pendingUploadFile = file;
        pendingUploadCampaignId = campaignId;
        logToConsole("⏳ 再ログイン後に自動でアップロードを再開するため、ファイルを一時保留しました。");
        return;
    }

    const consoleEl = document.getElementById('import-console');
    if (consoleEl) consoleEl.innerText = "";

    if (campaignId && campaignId.startsWith('camp_')) {
        logToConsole(`⚠️ エラー: スケジュールがデータベースに保存されていません。`);
        logToConsole(`💡 解決策: まず画面右上の「💾 スケジュールの変更を保存」ボタンを押して保存を完了させてから、CSVをアップロードしてください。`);
        showToast("⚠️ まず変更を保存してください。", "warning");
        return;
    }
    // 💡 誤アップロード・重複登録防止ガード：
    // すでに実績データがインポートされている場合は、先に「クリア」ボタンで削除させます。
    const actualDeliveries = smsDeliveriesCache.filter(d => d.campaign_id === campaignId);
    if (actualDeliveries.length > 0) {
        logToConsole(`⚠️ エラー: このスケジュールにはすでに配信結果CSVデータがアップロードされています。`);
        logToConsole(`💡 解決策: 再インポートする場合は、先に該当行の「クリア」ボタンを押して送信実績データをクリアしてください。`);
        showToast("⚠️ すでにアップロード済みです。先にクリアしてください。", "warning");
        return;
    }
    
    logToConsole(`📄 配信結果CSVファイルの読み込みを開始: ${file.name}`);

    try {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            encoding: "shift-jis", // Shift-JISエンコーディングを指定して直接ファイルをパース
            complete: async function(results) {
                try {
                    const rawRows = results.data;
                    const fieldnames = results.meta.fields;
                    logToConsole(`📊 CSVパース完了: ${rawRows.length} 件のレコードを検出しました。`);
                    
                    await processAndUploadRows(rawRows, fieldnames, 'haishin', campaignId);
                } catch (innerErr) {
                    console.error(innerErr);
                    logToConsole(`❌ CSVデータ処理中のエラー: ${innerErr.message || innerErr}`);
                    showToast("❌ データの解析・登録中にエラーが発生しました。", "error");
                }
            },
            error: function(err) {
                console.error(err);
                logToConsole(`❌ エラー: CSVのパースに失敗しました。 -> ${err}`);
                showToast("❌ CSVのパースに失敗しました。", "error");
            }
        });
    } catch (err) {
        console.error(err);
        logToConsole(`❌ インポート準備中のエラー: ${err.message || err}`);
        showToast("❌ インポートの初期化に失敗しました。", "error");
    }
}

// 12. 入庫予約CSVのドラッグ＆ドロップ連携ロジック

let selectedNyukoFile = null;

function initNyukoDragAndDrop() {
    const zone = document.getElementById('nyuko-dropzone');
    if (!zone) return;

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');

        const files = e.dataTransfer.files;
        if (files.length === 0) return;

        selectedNyukoFile = files[0];
        logToConsole(`🚗 ドラッグドロップで入庫予約ファイルを受理しました: ${selectedNyukoFile.name}`);
        startNyukoUpload();
    });
}

// 入庫予約ファイル手動選択
function handleNyukoFileSelect(event) {
    const files = event.target.files;
    if (files.length === 0) return;

    selectedNyukoFile = files[0];
    logToConsole(`🚗 ファイル選択で入庫予約ファイルを受理しました: ${selectedNyukoFile.name}`);
    startNyukoUpload();
    event.target.value = ""; // リセット
}

// 入庫予約アップロード開始
function startNyukoUpload() {
    if (!selectedNyukoFile) return;

    const consoleEl = document.getElementById('import-console');
    if (consoleEl) consoleEl.innerText = "";

    logToConsole(`🚀 入庫予約データ(nyuko)のパース＆インポート処理を開始します...`);

    try {
        Papa.parse(selectedNyukoFile, {
            header: true,
            skipEmptyLines: true,
            encoding: "shift-jis", // 直接パース処理
            complete: async function(results) {
                const rawRows = results.data;
                const fieldnames = results.meta.fields;
                logToConsole(`📊 CSVパース完了: ${rawRows.length} 件の入庫予約レコードを検出しました。`);
                
                await processAndUploadRows(rawRows, fieldnames, 'nyuko', null);
                
                // 完了後リセット
                selectedNyukoFile = null;
                const prompt = document.getElementById('nyuko-dropzone-prompt');
                if (prompt) prompt.innerText = `入庫予約CSVファイルをここにドラッグ＆ドロップするか、クリックして選択`;
            },
            error: function(err) {
                logToConsole(`❌ エラー: CSVのパースに失敗しました。 -> ${err}`);
                const prompt = document.getElementById('nyuko-dropzone-prompt');
                if (prompt) prompt.innerText = `入庫予約CSVファイルをここにドラッグ＆ドロップするか、クリックして選択`;
            }
        });
    } catch (err) {
        console.error(err);
        logToConsole(`❌ インポート準備中のエラー: ${err.message || err}`);
        showToast("❌ インポートの初期化に失敗しました。", "error");
    }
}


// 集計ルールの描画一覧
function renderMappingRules() {
    const tbody = document.getElementById('mapping-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (categoryMappingsCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">ルールが登録されていません。</td></tr>';
        return;
    }

    categoryMappingsCache.forEach(rule => {
        tbody.innerHTML += `
            <tr>
                <td style="font-weight: 600;">${rule.category}</td>
                <td><span style="padding: 2px 8px; border-radius: 12px; background: rgba(16, 185, 129, 0.15); color: #6ee7b7; font-size: 11px;">${rule.work_group}</span></td>
                <td>
                    <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="deleteMappingRule('${rule.id}')">🗑️ 削除</button>
                </td>
            </tr>
        `;
    });
}

// 新規集計ルールの追加
async function addMappingRule() {
    const category = document.getElementById('mapping-new-category').value;
    const workGroup = document.getElementById('mapping-new-workgroup').value.trim();

    if (!workGroup) {
        showToast("❌ 予約カテゴリ（作業グループ名）を入力してください。", "error");
        return;
    }

    const newRule = {
        category: category,
        work_group: workGroup
    };

    if (!supabaseClient) {
        // デモ環境
        newRule.id = "m_" + Math.random().toString(36).substr(2, 9);
        categoryMappingsCache.push(newRule);
        showToast("⚙️ 新しい集計ルールを追加しました（デモ）。", "success");
        renderMappingRules();
        document.getElementById('mapping-new-workgroup').value = "";
        return;
    }

    try {
        const { error } = await supabaseClient.from('category_mappings').insert([newRule]);
        if (error) throw error;

        showToast("⚙️ 新しい集計ルールを保存しました。", "success");
        document.getElementById('mapping-new-workgroup').value = "";
        await loadInitialData();
        renderMappingRules();
    } catch (err) {
        console.error(err);
        showToast("❌ ルールの追加に失敗しました。重複している可能性があります。", "error");
    }
}

// 集計ルールの削除
async function deleteMappingRule(id) {
    const rule = categoryMappingsCache.find(m => m.id === id);
    const displayRule = rule ? `${rule.category} ➡ ${rule.work_group}` : "この集計ルール";
    
    const ok = await showCustomConfirm(
        "集計ルールの削除",
        `ルール【<b>${displayRule}</b>】を削除しますか？<br><br>削除すると、該当する作業カテゴリ間の自動集計が機能しなくなります。`
    );
    if (!ok) return;

    if (!supabaseClient) {
        // デモ環境
        categoryMappingsCache = categoryMappingsCache.filter(m => m.id !== id);
        showToast("🗑️ ルールを削除しました（デモ）。", "success");
        renderMappingRules();
        return;
    }

    try {
        const { error } = await supabaseClient.from('category_mappings').delete().eq('id', id);
        if (error) throw error;

        showToast("🗑️ ルールを削除しました。", "success");
        await loadInitialData();
        renderMappingRules();
    } catch (err) {
        console.error(err);
        showToast("❌ ルールの削除に失敗しました。", "error");
    }
}

// 🌐 動的HTMLイベント用の関数をグローバル(window)オブジェクトに明示的にエクスポート
window.handleGridDragOver = handleGridDragOver;
window.handleGridDragLeave = handleGridDragLeave;
window.handleGridDrop = handleGridDrop;
window.triggerGridUpload = triggerGridUpload;
window.handleGridFileChange = handleGridFileChange;
window.deleteCampaignGridRow = deleteCampaignGridRow;
window.createMonthly10Campaigns = createMonthly10Campaigns;
window.addSingleCampaignRow = addSingleCampaignRow;
window.deleteMonthlyCampaigns = deleteMonthlyCampaigns;
window.handleAccordionMonthChange = handleAccordionMonthChange;
window.logToConsole = logToConsole;

// その他のイベントハンドラも同様にエクスポート
if (typeof handleGridDateChange !== 'undefined') window.handleGridDateChange = handleGridDateChange;
if (typeof handleGridCountChange !== 'undefined') window.handleGridCountChange = handleGridCountChange;
if (typeof handleGridCategoryChange !== 'undefined') window.handleGridCategoryChange = handleGridCategoryChange;
if (typeof handleGridTimingChange !== 'undefined') window.handleGridTimingChange = handleGridTimingChange;
if (typeof handleGridBeforeAfterChange !== 'undefined') window.handleGridBeforeAfterChange = handleGridBeforeAfterChange;
if (typeof handleGridWorkGroupChange !== 'undefined') window.handleGridWorkGroupChange = handleGridWorkGroupChange;
if (typeof handleGridWorkTypeIdChange !== 'undefined') window.handleGridWorkTypeIdChange = handleGridWorkTypeIdChange;
window.deleteCampaignDeliveries = deleteCampaignDeliveries;

// Vite移行に伴い、index.html側から直接呼び出される関数を window に追加で紐付け
window.handleGateAuth = handleGateAuth;
window.initTabSystem = initTabSystem;
window.validateTabElements = validateTabElements;
window.switchTab = switchTab;
window.openSetupModal = openSetupModal;
window.openAdminModal = openAdminModal;
window.handleAdminLogout = handleAdminLogout;
window.loadAllData = loadAllData;
window.handleAreaChange = handleAreaChange;
window.handleLogicToggle = handleLogicToggle;
window.saveStoreSmsGrid = saveStoreSmsGrid;
window.addStoreSmsGridRow = addStoreSmsGridRow;
window.loadStoreSmsGrid = loadStoreSmsGrid;
window.addCampaignGridRow = addCampaignGridRow;
window.saveCampaignGrid = saveCampaignGrid;
window.handleNyukoFileSelect = handleNyukoFileSelect;
window.loadStoresMaster = loadStoresMaster;
window.addStoreMasterRow = addStoreMasterRow;
window.openStoreImportModal = openStoreImportModal;
window.saveStoresMaster = saveStoresMaster;
window.addMappingRule = addMappingRule;
window.deleteMappingRule = deleteMappingRule;
window.toggleGridAccordion = toggleGridAccordion;
window.closeSetupModal = closeSetupModal;
window.handleSaveSetup = handleSaveSetup;
window.handleClearSetup = handleClearSetup;
window.closeAdminModal = closeAdminModal;
window.handleAdminLogin = handleAdminLogin;
window.closeStoreImportModal = closeStoreImportModal;
window.handleStoreImportSubmit = handleStoreImportSubmit;
window.loadReservationsList = loadReservationsList;
window.applyReservationFilters = applyReservationFilters;
window.updateMonthlySummary = updateMonthlySummary;
window.openAddReservationModal = openAddReservationModal;
window.openEditReservationModal = openEditReservationModal;
window.closeResEditModal = closeResEditModal;
window.handleSaveReservation = handleSaveReservation;
window.deleteReservation = deleteReservation;
window.deleteAllReservations = deleteAllReservations;

// 💡 自動テスト検証用のグローバルエクスポート
window.__appDebug = {
    get campaignsCache() { return campaignsCache; },
    set campaignsCache(val) { campaignsCache = val; },
    get storesCache() { return storesCache; },
    set storesCache(val) { storesCache = val; },
    get reservationsCache() { return reservationsCache; },
    set reservationsCache(val) { reservationsCache = val; },
    get reservationsListCache() { return reservationsListCache; },
    set reservationsListCache(val) { reservationsListCache = val; },
    renderCampaignGrid: renderCampaignGrid,
    deleteCampaignDeliveries: deleteCampaignDeliveries,
    processGridFile: processGridFile,
    saveCampaignGrid: saveCampaignGrid
};

