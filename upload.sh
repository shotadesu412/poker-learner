#!/bin/bash
echo "App用パスワードを入力してください（appleid.apple.comで生成）:"
read -s APP_PASSWORD

xcrun altool --upload-app \
  -f ~/Desktop/PokerLearner_export/ポーカーラッシュ.ipa \
  -t ios \
  -u "sinosino.9555412@softbank.ne.jp" \
  -p "$APP_PASSWORD"
