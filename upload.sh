#!/bin/bash
echo "Apple ID（メールアドレス）を入力してください:"
read APPLE_ID

echo "App用パスワードを入力してください（appleid.apple.comで生成）:"
read -s APP_PASSWORD

xcrun altool --upload-app \
  -f ~/Desktop/PokerLearner_export/ポーカーラッシュ.ipa \
  -t ios \
  -u "$APPLE_ID" \
  -p "$APP_PASSWORD"
