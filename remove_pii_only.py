# -*- coding: utf-8 -*-
"""
CSV個人情報削除スクリプト (配信・入庫データ対応版)
===========================================
以下のフォルダに配置されたCSVファイルに対して、個人情報列のみを削除し、上書き保存します。
※ファイル名から配信日や分類を追加する処理は行いません。

1. DL/配信 フォルダ:
  - 個人情報等（8列）の削除
2. DL/入庫 フォルダ:
  - 個人情報等（4列）の削除

処理の実行結果は `DL/操作ログ.txt` に追記されます。

使い方:
  python remove_pii_only.py
"""

import csv
import os
import glob
from datetime import datetime

# ============================================================
# 設定
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

def remove_pii_from_csv(filepath, columns_to_remove, label):
    """指定されたCSVファイルから、個人情報列を削除して上書き保存する"""
    filename = os.path.basename(filepath)
    try:
        with open(filepath, "r", encoding=ENCODING, newline="") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            if not fieldnames:
                print(f"  [{label}] スキップ（ヘッダなし）: {filename}")
                return "skip"

            # 削除対象の列が含まれているか確認
            has_target_cols = any(c in fieldnames for c in columns_to_remove)
            if not has_target_cols:
                print(f"  [{label}] スキップ（対象列なし/処理済み）: {filename}")
                return "skip"

            # 残す列のリストを作成
            clean_fieldnames = [c for c in fieldnames if c not in columns_to_remove]
            rows = list(reader)

        # 上書き保存
        with open(filepath, "w", encoding=ENCODING, newline="") as f:
            writer = csv.DictWriter(f, fieldnames=clean_fieldnames, quoting=csv.QUOTE_ALL, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow(row)

        removed_count = len(fieldnames) - len(clean_fieldnames)
        print(f"  [{label}] 完了: {filename} ({removed_count}列削除)")
        return "done"
    except Exception as e:
        print(f"  [{label}] エラー: {filename} -> {e}")
        return "error"


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))

    print("=" * 60)
    print("CSV個人情報削除スクリプト")
    print("=" * 60)

    results = {"haishin": {"done": 0, "skip": 0, "error": 0}, "nyuko": {"done": 0, "skip": 0, "error": 0}}

    # --- 配信データの処理 ---
    haishin_dir = os.path.join(script_dir, HAISHIN_FOLDER)
    haishin_files = sorted(glob.glob(os.path.join(haishin_dir, "*.csv")))
    if haishin_files:
        print(f"【配信データ】 {haishin_dir} (対象: {len(haishin_files)}件)")
        for filepath in haishin_files:
            res = remove_pii_from_csv(filepath, COLUMNS_TO_REMOVE_HAISHIN, "配信")
            results["haishin"][res] += 1
        print("-" * 60)

    # --- 入庫データの処理 ---
    nyuko_dir = os.path.join(script_dir, NYUKO_FOLDER)
    nyuko_files = sorted(glob.glob(os.path.join(nyuko_dir, "*.csv")))
    if nyuko_files:
        print(f"【入庫データ】 {nyuko_dir} (対象: {len(nyuko_files)}件)")
        for filepath in nyuko_files:
            res = remove_pii_from_csv(filepath, COLUMNS_TO_REMOVE_NYUKO, "入庫")
            results["nyuko"][res] += 1
        print("-" * 60)

    # 対象ファイルが見つからなかった場合
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
        f"[{now_str}] 個人情報削除処理実行（シンプル版）",
        f"  配信データ: 完了={results['haishin']['done']}, スキップ={results['haishin']['skip']}, エラー={results['haishin']['error']}",
        f"  入庫データ: 完了={results['nyuko']['done']}, スキップ={results['nyuko']['skip']}, エラー={results['nyuko']['error']}",
        "-" * 40 + "\n"
    ]
    
    try:
        # DLフォルダがない場合は作成
        os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
        with open(log_file_path, "a", encoding="utf-8") as lf:
            lf.write("\n".join(log_lines))
        print(f"操作ログを {LOG_FILE_PATH} に追記しました。")
    except Exception as e:
        print(f"操作ログの書き込みに失敗しました: {e}")

if __name__ == "__main__":
    main()
