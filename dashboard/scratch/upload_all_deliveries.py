# -*- coding: utf-8 -*-
"""
SMS送信実績一括アップロードスクリプト
===========================================
SMS配信結果フォルダ内のCSVを一括でクレンジング処理し、
Supabaseの `campaigns` および `sms_deliveries` テーブルへインポートします。

【処理特徴】
1. 個人情報（携帯番号、氏名、住所等）を自動的に除去。
2. 顧客IDや車台番号をSHA-256で不可逆ハッシュ化してデータベースに登録。
3. 店舗マスタ（stores）と自動的かつスマートに突き合わせ（SSコード/あいまい店舗名検索）。
4. ファイル名から、ダッシュボードの「定期配信10本を一括作成」と同じ詳細プロパティを割り当て。
5. 既に登録済みの配信実績がある場合、自動的に古いデータをクリアして上書き登録。
6. 1000件単位 of チャンク分割送信により、大容量CSVでもAPI制限に引っかからずにインポート。
7. ローカル検証（ドライラン）モードを搭載し、接続情報なしで解析結果をシミュレーション可能。
"""

import os
import re
import csv
import json
import hashlib
import urllib.request
import getpass
from datetime import datetime

# ============================================================
# 定数・設定
# ============================================================
ENCODING = "cp932"
CHUNK_SIZE = 1000

# 削除対象となる個人情報（PII）列
COLUMNS_TO_REMOVE = [
    "携帯電話番号", "自宅電話番号", "顧客名", "フリガナ",
    "email", "住所", "郵便番号", "担当者",
    "コメント", "備考", "メモ", "連絡事項", "備考欄", "その他"
]

# 「10本作成」に基づく設定テンプレート
TEMPLATES = [
    {
        "pattern": r"車検2[ヶケか月]",
        "category": "車検",
        "criteria": "満了日",
        "timing": "2ヶ月",
        "before_after": "前",
        "work_group": "事前点検",
        "work_type_id": "11755",
        "suffix": "車検2ヶ月前"
    },
    {
        "pattern": r"車検4[ヶケか月].*リピート",
        "category": "車検",
        "criteria": "満了日",
        "timing": "4ヶ月",
        "before_after": "前",
        "work_group": "事前点検",
        "work_type_id": "11755",
        "suffix": "車検4ヶ月前リピート"
    },
    {
        "pattern": r"車検4[ヶケか月].*新規",
        "category": "車検",
        "criteria": "満了日",
        "timing": "4ヶ月",
        "before_after": "前",
        "work_group": "事前点検",
        "work_type_id": "11755",
        "suffix": "車検4ヶ月前新規"
    },
    {
        "pattern": r"車検4[ヶケか月](?!.*リピート)(?!.*新規)",
        "category": "車検",
        "criteria": "満了日",
        "timing": "4ヶ月",
        "before_after": "前",
        "work_group": "事前点検",
        "work_type_id": "11755",
        "suffix": "車検4ヶ月前新規"
    },
    {
        "pattern": r"車検6[ヶケか月]",
        "category": "車検",
        "criteria": "満了日",
        "timing": "6ヶ月",
        "before_after": "前",
        "work_group": "事前点検",
        "work_type_id": "11755",
        "suffix": "車検6ヶ月前"
    },
    {
        "pattern": r"車検12[ヶケか月]",
        "category": "車検",
        "criteria": "満了日",
        "timing": "12ヶ月",
        "before_after": "前",
        "work_group": "12ヶ月点検",
        "work_type_id": "11760",
        "suffix": "車検12ヶ月前"
    },
    {
        "pattern": r"車検18[ヶケか月]",
        "category": "車検",
        "criteria": "満了日",
        "timing": "18ヶ月",
        "before_after": "前",
        "work_group": "6ケ月点検",
        "work_type_id": "11759",
        "suffix": "車検18ヶ月前"
    },
    {
        "pattern": r"オイル1",
        "category": "オイル",
        "criteria": "実施日",
        "timing": "5ヶ月",
        "before_after": "後",
        "work_group": "オイル交換",
        "work_type_id": "11762",
        "suffix": "オイル1"
    },
    {
        "pattern": r"オイル2",
        "category": "オイル",
        "criteria": "実施日",
        "timing": "6ヶ月",
        "before_after": "後",
        "work_group": "オイル交換",
        "work_type_id": "11762",
        "suffix": "オイル2"
    },
    {
        "pattern": r"コーティング1[ヶケか月]",
        "category": "コーティング",
        "criteria": "実施日",
        "timing": "1ヶ月",
        "before_after": "後",
        "work_group": "コーティング無料点検",
        "work_type_id": "17113",
        "suffix": "コーティング1ヶ月後"
    },
    {
        "pattern": r"コーティング11[ヶケか月]",
        "category": "コーティング",
        "criteria": "実施日",
        "timing": "11ヶ月",
        "before_after": "後",
        "work_group": "コーティング無料点検",
        "work_type_id": "17113",
        "suffix": "コーティング11ヶ月後"
    }
]

# ============================================================
# API 通信ユーティリティ
# ============================================================
def call_api(url, method="GET", headers=None, body=None):
    """標準ライブラリを使ったHTTPリクエスト共通関数"""
    if headers is None:
        headers = {}
    
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
            
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            res_body = res.read().decode("utf-8")
            if res_body:
                return json.loads(res_body), res.status
            return None, res.status
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8")
        raise Exception(f"HTTP {e.code} Error: {err_msg}")
    except Exception as e:
        raise Exception(f"通信エラー: {e}")

# ============================================================
# 処理ロジック
# ============================================================
def clean_store_name(name):
    """あいまい店舗名比較用の正規化"""
    if not name:
        return ""
    s = str(name).lower()
    s = re.sub(r'[\s　]+', '', s)          # スペース除去
    s = s.replace('セルフ', '')            # 「セルフ」除去
    s = re.sub(r'dr\.drive|dr\-|dd', '', s) # 「Dr.Drive」「DD」など除去
    if s.endswith('店'):
        s = s[:-1]                          # 末尾の「店」除去
    return s

def parse_filename(filename):
    """ファイル名から配信日とキャンペーンのタイプ（接尾辞）を抽出する"""
    name, _ = os.path.splitext(filename)
    
    # 先頭の8桁日付（YYYYMMDD）をスキャン
    match = re.match(r"^(\d{8})[_\s]*(.*)$", name)
    if not match:
        return None, None, None
        
    date_str = match.group(1)
    rest_name = match.group(2).strip()
    
    try:
        dt = datetime.strptime(date_str, "%Y%m%d")
        delivery_date = dt.strftime("%Y-%m-%d")
    except ValueError:
        return None, None, None
        
    # 定期テンプレートとのマッチングを試みる
    matched_temp = None
    for temp in TEMPLATES:
        if re.search(temp["pattern"], rest_name):
            matched_temp = temp
            break
            
    if matched_temp:
        campaign_name = f"{date_str} {matched_temp['suffix']}"
        return delivery_date, campaign_name, matched_temp
    else:
        # テンプレートに一致しない場合はファイル名をそのままキャンペーン名に
        campaign_name = f"{date_str} {rest_name}"
        return delivery_date, campaign_name, None

def get_or_create_campaign(supabase_url, anon_key, token, delivery_date, campaign_name, template, campaigns_cache):
    """既存のキャンペーンを探すか、なければ新規作成してUUIDを返す"""
    # キャッシュから探す
    for camp in campaigns_cache:
        if camp.get("delivery_date") == delivery_date and camp.get("campaign_name") == campaign_name:
            return camp.get("id")
            
    # ない場合は新規作成
    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {token}",
        "Prefer": "return=representation" # 作成されたレコードを取得
    }
    
    category = "その他"
    criteria = None
    timing = None
    before_after = None
    work_group = None
    work_type_id = None
    
    if template:
        category = template["category"]
        criteria = template["criteria"]
        timing = template["timing"]
        before_after = template["before_after"]
        work_group = template["work_group"]
        work_type_id = template["work_type_id"]
    else:
        # ファイル名から大雑把なカテゴリ判定
        if "車検" in campaign_name:
            category = "車検"
        elif "オイル" in campaign_name:
            category = "オイル"
        elif "コーティング" in campaign_name:
            category = "コーティング"
        elif "点検" in campaign_name:
            category = "点検"
            
    new_camp_data = {
        "delivery_date": delivery_date,
        "campaign_name": campaign_name,
        "category": category,
        "sent_count_report": 0,
        "criteria": criteria,
        "timing": timing,
        "before_after": before_after,
        "work_group": work_group,
        "work_type_id": work_type_id
    }
    
    url = f"{supabase_url}/rest/v1/campaigns"
    res, _ = call_api(url, method="POST", headers=headers, body=new_camp_data)
    if res and len(res) > 0:
        new_id = res[0]["id"]
        campaigns_cache.append({
            "id": new_id,
            "campaign_name": campaign_name,
            "delivery_date": delivery_date
        })
        print(f"  [新規] 新規キャンペーンを自動登録しました: {campaign_name} (カテゴリ: {category})")
        return new_id
    else:
        raise Exception(f"キャンペーンの作成に失敗しました: {campaign_name}")

def process_csv_file(filepath, campaign_id, stores_list):
    """CSVを読み込んで個人情報除外、IDハッシュ化、店舗コード照合を行い、明細レコードのリストを生成"""
    stores_by_code = {s["store_code"]: s for s in stores_list}
    clean_stores = [{**s, "clean_name": clean_store_name(s["store_name"])} for s in stores_list]
    
    records = []
    
    with open(filepath, "r", encoding=ENCODING, errors="ignore") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if not fieldnames:
            return []
            
        # 突合キーの判定用
        key_col = None
        for col in ["ID", "顧客コード", "車台番号"]:
            if col in fieldnames:
                key_col = col
                break
                
        for idx, row in enumerate(reader):
            # 突合キーがない行はスキップ
            raw_key_val = row.get(key_col) if key_col else None
            if not raw_key_val:
                continue
                
            # 不可逆ハッシュ化 (SHA-256)
            hashed_id = hashlib.sha256(raw_key_val.strip().encode("utf-8")).hexdigest()
            
            # 店舗の特定
            csv_store_name = row.get("店舗名") or row.get("店舗") or ""
            csv_store_code = row.get("発券SSコード") or row.get("SSコード") or ""
            
            matched_code = csv_store_code.strip()
            
            # SSコードがマスタに存在しない場合、店舗名からあいまいマッチング
            if (not matched_code or matched_code not in stores_by_code) and csv_store_name:
                cleaned_csv = clean_store_name(csv_store_name)
                if cleaned_csv:
                    # 1. 完全一致
                    matched_store = None
                    for s in clean_stores:
                        if s["clean_name"] == cleaned_csv:
                            matched_store = s
                            break
                    # 2. 部分一致
                    if not matched_store:
                        for s in clean_stores:
                            if cleaned_csv in s["clean_name"] or s["clean_name"] in cleaned_csv:
                                matched_store = s
                                break
                    if matched_store:
                        matched_code = matched_store["store_code"]
                        
            if not matched_code or matched_code not in stores_by_code:
                matched_code = "unknown"
                
            # 送信通数
            sms_count = 1
            if row.get("通数"):
                try:
                    sms_count = int(row.get("通数"))
                except ValueError:
                    pass
                    
            # ナンバープレート情報の抽出
            car_land = (row.get("ナンバー（陸事）") or "").strip() or None
            car_class = (row.get("ナンバー（種別）") or "").strip() or None
            car_kana = (row.get("ナンバー（かな）") or "").strip() or None
            car_num = (row.get("ナンバー（車番）") or "").strip() or None

            records.append({
                "campaign_id": campaign_id,
                "store_code": matched_code,
                "hashed_customer_id": hashed_id,
                "sms_count": sms_count,
                "car_land": car_land,
                "car_class": car_class,
                "car_kana": car_kana,
                "car_num": car_num
            })
            
    return records

def upload_sms_deliveries(supabase_url, anon_key, token, campaign_id, records):
    """該当キャンペーンの古いデータを削除し、新規の送信実績をインサート"""
    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {token}"
    }
    
    # 1. 既存の紐づく実績を削除 (DELETE)
    del_url = f"{supabase_url}/rest/v1/sms_deliveries?campaign_id=eq.{campaign_id}"
    call_api(del_url, method="DELETE", headers=headers)
    
    if not records:
        return 0
        
    # 2. 1000件ずつのチャンクに分けてインサート
    ins_url = f"{supabase_url}/rest/v1/sms_deliveries"
    headers["Prefer"] = "return=minimal" # レスポンスボディを空にして通信量削減
    
    total_inserted = 0
    total_chunks = (len(records) + CHUNK_SIZE - 1) // CHUNK_SIZE
    
    for i in range(0, len(records), CHUNK_SIZE):
        chunk = records[i:i+CHUNK_SIZE]
        chunk_idx = (i // CHUNK_SIZE) + 1
        
        if total_chunks > 1:
            print(f"    [インポート中] チャンク {chunk_idx}/{total_chunks} 送信中 ({len(chunk)}件)...")
            
        call_api(ins_url, method="POST", headers=headers, body=chunk)
        total_inserted += len(chunk)
        
    return total_inserted

def load_stores_from_sql(workspace_root):
    """insert_stores.sql ファイルから店舗マスタ情報を読み込む (ドライラン用)"""
    sql_path = os.path.join(workspace_root, "dashboard", "insert_stores.sql")
    stores = []
    if not os.path.exists(sql_path):
        return stores
        
    try:
        with open(sql_path, "r", encoding="utf-8") as f:
            content = f.read()
        # ('8003022', 'Dr. Driveセルフ羽島店', '中国1G') 形式を抽出
        matches = re.findall(r"\('(\d+)',\s*'([^']+)',\s*'([^']+)'\)", content)
        for code, name, area in matches:
            stores.append({
                "store_code": code,
                "store_name": name,
                "area_name": area
            })
    except Exception as e:
        print(f"  [警告] insert_stores.sql のパースに失敗しました: {e}")
    return stores

# ============================================================
# メイン処理
# ============================================================
def main():
    print("=" * 60)
    print(" ENEOSモビリニア SMS送信実績一括アップロードツール")
    print("=" * 60)
    print("※本ツールは、CSVファイルから個人情報を除去して暗号化した上で、")
    print("  Supabaseデータベースへアップロードします。")
    print("-" * 60)
    
    print("実行モードを選択してください:")
    print("  1. 通常実行 (Supabaseに接続して実際にデータを登録する)")
    print("  2. ドライラン (データベースに接続せず、CSVの解析・店舗照合の検証のみを行う)")
    mode = input("選択してください (1/2, デフォルト: 1): ").strip()
    if not mode:
        mode = "1"
        
    # パス設定
    script_dir = os.path.dirname(os.path.abspath(__file__))
    workspace_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    haishin_folder = os.path.join(workspace_root, "SMS配信結果")
    
    if not os.path.exists(haishin_folder):
        haishin_folder = os.path.abspath("SMS配信結果")
        if not os.path.exists(haishin_folder):
            print(f"[エラー] SMS配信結果フォルダが見つかりません。パスを確認してください: {haishin_folder}")
            return
            
    # CSVファイルのリストアップ
    csv_files = [f for f in os.listdir(haishin_folder) if f.lower().endswith(".csv")]
    if not csv_files:
        print("[エラー] フォルダ内にCSVファイルが見つかりません。")
        return
    csv_files.sort()
    
    if mode == "2":
        print("\n[検証] ドライラン（ローカル検証モード）を開始します...")
        stores_list = load_stores_from_sql(workspace_root)
        print(f"  ・ローカルSQLから {len(stores_list)} 店舗のマスタデータをロードしました。")
        
        success_count = 0
        total_rows_imported = 0
        skipped_count = 0
        unknown_stores_details = {}
        
        for idx, filename in enumerate(csv_files):
            delivery_date, campaign_name, template = parse_filename(filename)
            if not delivery_date:
                print(f"  [{idx+1}/{len(csv_files)}] [スキップ] {filename} (日付判別不可)")
                skipped_count += 1
                continue
                
            filepath = os.path.join(haishin_folder, filename)
            
            try:
                # ドライラン用の擬似キャンペーンID
                dummy_campaign_id = "dummy-campaign-uuid-1234"
                
                # CSVパース＆クレンジング検証
                records = process_csv_file(filepath, dummy_campaign_id, stores_list)
                
                # 店舗判定結果の集計
                unknown_in_file = 0
                for r in records:
                    if r["store_code"] == "unknown":
                        unknown_in_file += 1
                
                cat_name = template["category"] if template else "不明/その他"
                print(f"  [{idx+1}/{len(csv_files)}] [成功] 解析成功: {filename}")
                print(f"     -> 配信日: {delivery_date} | キャンペーン名: {campaign_name} | カテゴリ: {cat_name}")
                print(f"     -> レコード件数: {len(records)} 件 (店舗不明: {unknown_in_file} 件)")
                
                if unknown_in_file > 0:
                    # 不明店舗のサンプルを取得して記録
                    with open(filepath, "r", encoding=ENCODING, errors="ignore") as f:
                        r_csv = csv.DictReader(f)
                        for r_row in r_csv:
                            csv_name = r_row.get("店舗名") or r_row.get("店舗") or ""
                            csv_code = r_row.get("発券SSコード") or r_row.get("SSコード") or ""
                            # 判定してみる
                            dummy_recs = process_csv_file(filepath, dummy_campaign_id, stores_list)
                            # 今回の行に対応する店舗判定を再現
                            hashed_id = hashlib.sha256((r_row.get("ID") or r_row.get("顧客コード") or r_row.get("車台番号") or "").strip().encode("utf-8")).hexdigest()
                            matched_c = "unknown"
                            for dr in dummy_recs:
                                if dr["hashed_customer_id"] == hashed_id:
                                    matched_c = dr["store_code"]
                                    break
                            if matched_c == "unknown" and csv_name:
                                key = f"{csv_name} (コード: {csv_code})"
                                unknown_stores_details[key] = unknown_stores_details.get(key, 0) + 1
                
                success_count += 1
                total_rows_imported += len(records)
                
            except Exception as e:
                print(f"  [{idx+1}/{len(csv_files)}] [エラー] {filename} -> {e}")
                skipped_count += 1
                
        print("\n" + "=" * 60)
        print(" ドライラン（検証）結果のまとめ")
        print("=" * 60)
        print(f"・対象CSVファイル数  : {len(csv_files)} 件")
        print(f"・解析・検証成功     : {success_count} 件")
        print(f"・解析失敗/スキップ  : {skipped_count} 件")
        print(f"・想定インポート行数  : {total_rows_imported} 件")
        
        if unknown_stores_details:
            print("\n[注意] 店舗マスタに適合しなかった店舗名（unknownとして処理されたもの）:")
            # 出現回数の多い順に表示
            sorted_unknowns = sorted(unknown_stores_details.items(), key=lambda x: x[1], reverse=True)
            for name_info, count in sorted_unknowns[:20]: # 最大20件表示
                print(f"   - {name_info} : {count} 件")
            if len(sorted_unknowns) > 20:
                print(f"   ...他 {len(sorted_unknowns) - 20} 店舗")
                
        print("-" * 60)
        print("[完了] ドライランによるローカル検証が完了しました！")
        print("解析に失敗したファイルがないか、上記のログをご確認ください。")
        print("=" * 60)
        return

    # 通常実行モード
    # 接続設定の入力
    supabase_url = input("1. Supabase URL (例: https://xxxx.supabase.co): ").strip()
    anon_key = input("2. Supabase Anon Key (または Service Role Key): ").strip()
    admin_email = input("3. 管理者メールアドレス (例: admin@example.com): ").strip()
    admin_password = input("4. 管理者パスワード (画面に表示されます): ").strip()
    
    print("\n[ログイン] Supabaseにログイン中...")
    try:
        login_url = f"{supabase_url}/auth/v1/token?grant_type=password"
        login_headers = {
            "apikey": anon_key,
            "Content-Type": "application/json"
        }
        login_body = {
            "email": admin_email,
            "password": admin_password
        }
        res, _ = call_api(login_url, method="POST", headers=login_headers, body=login_body)
        token = res["access_token"]
        print("[成功] ログインに成功しました。")
    except Exception as e:
        print(f"[エラー] ログインに失敗しました: {e}")
        return
        
    print("\n[設定] データベースから初期データをロード中...")
    try:
        # 店舗マスタの読み込み
        stores_url = f"{supabase_url}/rest/v1/stores?select=store_code,store_name,area_name"
        stores_headers = {
            "apikey": anon_key,
            "Authorization": f"Bearer {token}"
        }
        stores_list, _ = call_api(stores_url, method="GET", headers=stores_headers)
        print(f"  ・店舗マスタ: {len(stores_list)}店舗ロード完了")
        
        # 既存キャンペーンの読み込み
        camps_url = f"{supabase_url}/rest/v1/campaigns?select=id,campaign_name,delivery_date"
        camps_headers = {
            "apikey": anon_key,
            "Authorization": f"Bearer {token}"
        }
        campaigns_cache, _ = call_api(camps_url, method="GET", headers=camps_headers)
        print(f"  ・登録済みキャンペーン: {len(campaigns_cache)}件ロード完了")
    except Exception as e:
        print(f"[エラー] 初期データのロード中にエラーが発生しました: {e}")
        return
        
    print(f"\n[フォルダ] 送信実績CSVフォルダを検出しました:\n   {haishin_folder}")
    print(f"[集計] 処理対象CSV: {len(csv_files)} 件")
    
    confirm = input("インポートを開始してよろしいですか？ (y/n): ").strip().lower()
    if confirm != 'y':
        print("キャンセルされました。")
        return
        
    print("\n[開始] 一括インポート処理を開始します...")
    
    success_count = 0
    total_rows_imported = 0
    skipped_count = 0
    
    for idx, filename in enumerate(csv_files):
        print(f"\n[{idx+1}/{len(csv_files)}] [ファイル] {filename} を処理中...")
        
        delivery_date, campaign_name, template = parse_filename(filename)
        if not delivery_date:
            print("  [警告] スキップ: ファイル名の先頭から配信日(YYYYMMDD)を判別できませんでした。")
            skipped_count += 1
            continue
            
        filepath = os.path.join(haishin_folder, filename)
        
        try:
            # 1. キャンペーンの取得または作成
            campaign_id = get_or_create_campaign(
                supabase_url, anon_key, token,
                delivery_date, campaign_name, template,
                campaigns_cache
            )
            
            # 2. CSVの前処理（PII除去・ハッシュ化・店舗コード突合）
            records = process_csv_file(filepath, campaign_id, stores_list)
            if not records:
                print("  [警告] 有効な明細データが検出されませんでした。")
                
            # 3. データベースへの登録（上書き削除 ＆ チャンクインサート）
            inserted_count = upload_sms_deliveries(supabase_url, anon_key, token, campaign_id, records)
            
            print(f"  [成功] 処理完了: データベースに送信実績 {inserted_count} 件を登録しました。")
            success_count += 1
            total_rows_imported += inserted_count
            
        except Exception as e:
            print(f"  [エラー] 処理中に問題が発生しました -> {e}")
            
    print("\n" + "=" * 60)
    print(" 処理結果のまとめ")
    print("=" * 60)
    print(f"・総CSVファイル数  : {len(csv_files)} 件")
    print(f"・インポート成功   : {success_count} 件")
    print(f"・スキップ (エラー) : {skipped_count} 件")
    print(f"・総インポート行数  : {total_rows_imported} 件")
    print("-" * 60)
    print("[完了] 一括アップロード処理がすべて完了しました！")
    print("ダッシュボードを開いて結果をご確認ください。")
    print("=" * 60)

if __name__ == "__main__":
    main()
