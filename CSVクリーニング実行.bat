@echo off
set SCRIPT_PATH="%~dp0remove_pii_columns.py"
set PYTHON_EXE="%LOCALAPPDATA%\Programs\Python\Python312\python.exe"

echo --------------------------------------------------
echo CSVクリーニング処理を開始します...
echo --------------------------------------------------

if not exist %PYTHON_EXE% (
    echo [エラー] Pythonが見つかりませんでした。
    echo パスを確認してください: %PYTHON_EXE%
    pause
    exit /b
)

%PYTHON_EXE% %SCRIPT_PATH%

echo.
echo --------------------------------------------------
echo 処理が完了しました。
echo 実行結果は DL\操作ログ.txt を確認してください。
echo --------------------------------------------------
echo.
pause
