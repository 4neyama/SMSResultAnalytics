import { chromium } from 'playwright';

(async () => {
  console.log("🚀 Starting Playwright to diagnose http://localhost:5173/ with credentials...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('console', msg => {
    console.log(`[BROWSER CONSOLE] [${msg.type()}] ${msg.text()}`);
  });

  page.on('pageerror', err => {
    console.log(`[BROWSER EXCEPTION] ${err.stack || err.message}`);
  });

  try {
    // 1. 初回訪問して localStorage をセットできるようにする
    await page.goto('http://localhost:5173/');
    
    await page.evaluate(() => {
      // 共通パスワード認証を通過状態にする
      localStorage.setItem('gate_authenticated', 'true');
      // Supabase 未接続設定（デモモードを促す状態）
      localStorage.removeItem('SUPABASE_URL');
      localStorage.removeItem('SUPABASE_ANON_KEY');
    });

    // 2. リロードして適用
    console.log("🔄 Reloading page after setting credentials...");
    await page.reload({ waitUntil: 'load' });

    // 各要素のチェック
    const authGateState = await page.evaluate(() => {
      const el = document.getElementById('auth-gate');
      return el ? { display: el.style.display, classes: Array.from(el.classList) } : null;
    });
    console.log("🔑 #auth-gate state:", authGateState);

    const activeTab = await page.evaluate(() => {
      const activeContents = Array.from(document.querySelectorAll('.tab-content')).map(el => ({
        id: el.id,
        display: window.getComputedStyle(el).display,
        classes: Array.from(el.classList)
      }));
      return activeContents;
    });
    console.log("📋 Tab contents states:", activeTab);

  } catch (err) {
    console.error("❌ Diagnostic run failed:", err);
  } finally {
    await browser.close();
    console.log("🏁 Done.");
  }
})();
