# -*- coding: utf-8 -*-
"""
CSV前処理スクリプト (配信・入庫データ対応版 + ログ出力機能付き)
===========================================
以下のフォルダに配置されたCSVファイルに対して、それぞれ固有の前処理を行い、上書き保存します。

1. DL/配信 フォルダ:
  - 個人情報等（8列）の削除
  - ファイル名から「配信日」「分類」を抽出して先頭列として追加
2. DL/入庫 フォルダ:
  - 個人情報等（4列）の削除

処理の実行結果は `DL/操作ログ.txt` に追記されます。

使い方:
  python remove_pii_columns.py
"""

import csv
import os
import glob
import re
from datetime import datetime

# ============================================================
# 設定（必要に応じて変更してください）
# ============================================================

# エンコーディング（Windows CSVの場合は cp932 が安全）
ENCODING = "cp932"

# ログ出力先
LOG_FILE_PATH = os.path.join("DL", "操作ログ.txt")

# -----------------
# 配信データ用の設定
# -----------------
HAISHIN_FOLDER = os.path.join("DL", "配信")
COLUMNS_TO_REMOVE_HAISHIN = [
    "携帯電話番号", "自宅電話番号", "顧客名", "フリガナ",
    "ナンバー（陸事）", "ナンバー（種別）", "ナンバー（かな）", "ナンバー（車番）"
]
CLASSIFICATION_RULES = [
    # (キーワード, 月数条件, 分類)
    ("車検", lambda months: months is not None and months >= 12, "点検"),
    ("車検", lambda months: True, "車検"),
    ("オイル", lambda months: True, "オイル"),
    ("コーティング", lambda months: True, "コーティング"),
]

# -----------------
# 入庫データ用の設定
# -----------------
NYUKO_FOLDER = os.path.join("DL", "入庫")
COLUMNS_TO_REMOVE_NYUKO = [
    "お客様名", "ふりがな", "連絡先電話番号（自宅）", "連絡先電話番号（携帯）"
]


# ============================================================
# 処理本体
# ============================================================

def parse_filename(filename):
    """配信ファイル名から配信日と分類を抽出する"""
    name = os.path.splitext(filename)[0]
    parts = name.split("_")
    if len(parts) < 3:
        return None, None

    date_str = parts[0]
    if len(date_str) == 8 and date_str.isdigit():
        year, month, day = int(date_str[0:4]), int(date_str[4:6]), int(date_str[6:8])
        formatted_date = f"{year}/{month}/{day}"
    else:
        return None, None

    content = "_".join(parts[1:-1])
    return formatted_date, content


def classify_content(content):
    """配信内容から分類を判定する"""
    if content is None: return None
    month_match = re.search(r"(\d+)\s*[ヶケか月]", content)
    months = int(month_match.group(1)) if month_match else None

    for keyword, condition, classification in CLASSIFICATION_RULES:
        if keyword in content and condition(months):
            return classification
    return content


def process_haishin_csv(filepath):
    """配信データ用の処理"""
    filename = os.path.basename(filepath)
    delivery_date, content = parse_filename(filename)
    if not delivery_date:
        print(f"  [配信] スキップ（ファイル名パース不可）: {filename}")
        return "skip"

    classification = classify_content(content)
    if not classification:
        print(f"  [配信] スキップ（分類判定不可）: {filename}")
        return "skip"

    try:
        with open(filepath, "r", encoding=ENCODING, newline="") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            if not fieldnames:
                print(f"  [配信] スキップ（ヘッダなし）: {filename}")
                return "skip"

            clean_fieldnames = [c for c in fieldnames if c not in COLUMNS_TO_REMOVE_HAISHIN]
            rows = list(reader)

        new_fieldnames = ["配信日", "分類"] + clean_fieldnames
        with open(filepath, "w", encoding=ENCODING, newline="") as f:
            writer = csv.writer(f, quoting=csv.QUOTE_ALL)
            writer.writerow(new_fieldnames)
            for row in rows:
                new_row = [delivery_date, classification] + [row.get(col, "") for col in clean_fieldnames]
                writer.writerow(new_row)

        print(f"  [配信] 完了: {filename} (日付={delivery_date}, 分類={classification}, {len(fieldnames)-len(clean_fieldnames)}列削除)")
        return "done"
    except Exception as e:
        print(f"  [配信] エラー: {filename} -> {e}")
        return "error"


def process_nyuko_csv(filepath):
    """入庫データ用の処理"""
    filename = os.path.basename(filepath)
    try:
        with open(filepath, "r", encoding=ENCODING, newline="") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            if not fieldnames:
                print(f"  [入庫] スキップ（ヘッダなし）: {filename}")
                return "skip"

            has_target_cols = any(c in fieldnames for c in COLUMNS_TO_REMOVE_NYUKO)
            if not has_target_cols:
                print(f"  [入庫] スキップ（対象列なし/処理済み）: {filename}")
                return "skip"

            clean_fieldnames = [c for c in fieldnames if c not in COLUMNS_TO_REMOVE_NYUKO]
            rows = list(reader)

        with open(filepath, "w", encoding=ENCODING, newline="") as f:
            writer = csv.DictWriter(f, fieldnames=clean_fieldnames, quoting=csv.QUOTE_ALL, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow(row)

        print(f"  [入庫] 完了: {filename} ({len(fieldnames)-len(clean_fieldnames)}列削除)")
        return "done"
    except Exception as e:
        print(f"  [入庫] エラー: {filename} -> {e}")
        return "error"


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))

    print("=" * 60)
    print("CSV前処理スクリプト (配信・入庫 対応版)")
    print("=" * 60)

    results = {"haishin": {"done": 0, "skip": 0, "error": 0}, "nyuko": {"done": 0, "skip": 0, "error": 0}}

    # --- 配信データの処理 ---
    haishin_dir = os.path.join(script_dir, HAISHIN_FOLDER)
    haishin_files = sorted(glob.glob(os.path.join(haishin_dir, "*.csv")))
    if haishin_files:
        print(f"【配信データ】 {haishin_dir} (対象: {len(haishin_files)}件)")
        for filepath in haishin_files:
            res = process_haishin_csv(filepath)
            results["haishin"][res] += 1
        print("-" * 60)

    # --- 入庫データの処理 ---
    nyuko_dir = os.path.join(script_dir, NYUKO_FOLDER)
    nyuko_files = sorted(glob.glob(os.path.join(nyuko_dir, "*.csv")))
    if nyuko_files:
        print(f"【入庫データ】 {nyuko_dir} (対象: {len(nyuko_files)}件)")
        for filepath in nyuko_files:
            res = process_nyuko_csv(filepath)
            results["nyuko"][res] += 1
        print("-" * 60)

    # 見つからなかった場合のメッセージ
    if not haishin_files and not nyuko_files:
        print("対象ファイルが見つかりませんでした。")
        return

    # コンソール出力
    print("処理結果:")
    print(f"  [配信] 完了={results['haishin']['done']}, スキップ={results['haishin']['skip']}, エラー={results['haishin']['error']}")
    print(f"  [入庫] 完了={results['nyuko']['done']}, スキップ={results['nyuko']['skip']}, エラー={results['nyuko']['error']}")
    print("=" * 60)

    # --- ログファイルへの書き出し ---
    log_file_path = os.path.join(script_dir, LOG_FILE_PATH)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_lines = [
        f"[{now_str}] 処理実行",
        f"  配信データ: 完了={results['haishin']['done']}, スキップ={results['haishin']['skip']}, エラー={results['haishin']['error']}",
        f"  入庫データ: 完了={results['nyuko']['done']}, スキップ={results['nyuko']['skip']}, エラー={results['nyuko']['error']}",
        "-" * 40 + "\n"
    ]
    
    try:
        with open(log_file_path, "a", encoding="utf-8") as lf:
            lf.write("\n".join(log_lines))
        print(f"操作ログを {LOG_FILE_PATH} に追記しました。")
    except Exception as e:
        print(f"操作ログの書き込みに失敗しました: {e}")

if __name__ == "__main__":
    main()
