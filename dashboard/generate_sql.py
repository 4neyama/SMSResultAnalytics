# -*- coding: utf-8 -*-
import csv

# 1. エリアデータの読み込み
area_map = {}
with open('area_shop_csv/area_data_20260524004358.csv', 'r', encoding='cp932') as f:
    r = csv.DictReader(f)
    for row in r:
        area_map[row['id']] = row['name']

# 2. 所属データの読み込み
belong_map = {}
with open('area_shop_csv/belong_data_20260524004245.csv', 'r', encoding='cp932') as f:
    r = csv.DictReader(f)
    for row in r:
        belong_map[row['name'].strip()] = area_map.get(row['nskn_area_id'], 'その他')

# 3. ユーザー提供の対応表
mappings = [
    ('8003022', 'Dr. Driveセルフ羽島店'),
    ('1015874', 'Dr. Driveセルフ広江店'),
    ('1016005', 'Dr. Driveセルフ中仙道店'),
    ('3726288', 'Dr. Driveセルフ箕島店'),
    ('1015858', 'セルフ早島インター上り線SS'),
    ('1015965', 'Dr. Driveセルフ野田店'),
    ('1015767', 'Dr. Driveセルフ岡山ネオポリス店'),
    ('8001877', 'Dr. Driveセルフ東岡山店'),
    ('1015833', 'Dr. Drive柳川セントラル店'),
    ('1016039', 'Dr. Driveセルフ水島インター店'),
    ('1015783', 'Dr. Driveセルフ西大寺金岡店'),
    ('1015791', 'Dr. Driveセルフ神崎店'),
    ('1015957', 'Dr. Driveセルフ田井ポート店'),
    ('8002974', 'Dr. Driveセルフ総社店'),
    ('1016047', 'Dr. Driveセルフ藤田店'),
    ('1015841', 'Dr. Driveセルフ吉備路店'),
    ('8002594', 'Dr. Driveセルフ西大寺店'),
    ('1015973', 'Dr. Drive富田店'),
    ('8104622', 'Dr. Driveセルフ中筋店'),
    ('1016153', 'Dr. Driveセルフ新涯店'),
    ('1016229', 'Dr. Driveセルフアメニティー焼山店'),
    ('1016252', 'Dr. Driveセルフ西条中央店'),
    ('1016278', 'Dr. Driveセルフ鴨方インター店'),
    ('3726304', 'Dr. Driveセルフ新伊勢丘店'),
    ('8103657', 'Dr. Driveセルフ中央店'),
    ('1016203', 'セルフ黒瀬SS'),
    ('8103152', 'Dr. Driveセルフ矢野店'),
    ('8103293', 'Dr. Driveセルフ亀山店'),
    ('8104481', 'Dr. Driveセルフ安佐北店'),
    ('1016179', 'EneJetセルフせとうち尾道店'),
    ('7015944', '周南SS'),
    ('7019664', '吉見園SS'),
    ('7020480', '沼田SS')
]

seen_codes = set()
sql_values = []

for code, name in mappings:
    if code in seen_codes:
        continue
    seen_codes.add(code)
    
    area_name = 'その他'
    
    # 手動エリア判定とCSVマージ
    for b_name, a_name in belong_map.items():
        if name in b_name or b_name in name:
            area_name = a_name
            break
            
    # 文字化け補正と手動マッピングの上書き
    if '羽島' in name: area_name = '中国1G'
    elif '広江' in name: area_name = '中国1G'
    elif '中仙道' in name: area_name = '中国2G'
    elif '箕島' in name: area_name = '中国2G'
    elif '早島' in name: area_name = '中国1G'
    elif '野田' in name: area_name = '中国2G'
    elif 'ネオポリス' in name: area_name = '中国1G'
    elif '東岡山' in name: area_name = '中国1G'
    elif '柳川' in name: area_name = '中国1G'
    elif '水島' in name: area_name = '中国2G'
    elif '西大寺' in name: area_name = '中国1G'
    elif '神崎' in name: area_name = '中国1G'
    elif '田井' in name: area_name = '中国2G'
    elif '総社' in name: area_name = '中国2G'
    elif '藤田' in name: area_name = '中国2G'
    elif '吉備路' in name: area_name = '中国1G'
    elif '富田' in name: area_name = '中国2G'
    elif '中筋' in name: area_name = '中国4G'
    elif '新涯' in name: area_name = '中国3G'
    elif '焼山' in name: area_name = '中国3G'
    elif '西条' in name: area_name = '中国4G'
    elif '鴨方' in name: area_name = '中国2G'
    elif '新伊勢丘' in name: area_name = '中国3G'
    elif '中央' in name: area_name = '中国4G'
    elif '黒瀬' in name: area_name = '中国4G'
    elif '矢野' in name: area_name = '中国4G'
    elif '亀山' in name: area_name = '中国1G'
    elif '安佐北' in name: area_name = '中国4G'
    elif 'せとうち' in name: area_name = '中国3G'
    
    clean_name = name.strip()
    sql_values.append("('{}', '{}', '{}')".format(code, clean_name, area_name))

output_sql = "INSERT INTO stores (store_code, store_name, area_name) VALUES\n"
output_sql += ",\n".join(sql_values)
output_sql += "\nON CONFLICT (store_code) DO UPDATE SET store_name = EXCLUDED.store_name, area_name = EXCLUDED.area_name;"

# UTF-8で出力ファイルに保存
with open('dashboard/insert_stores.sql', 'w', encoding='utf-8') as out_f:
    out_f.write(output_sql)

print("SQL file successfully generated in UTF-8: dashboard/insert_stores.sql")
