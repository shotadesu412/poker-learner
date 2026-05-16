#!/bin/bash
set -e

PROJECT=~/Desktop/poker-learner/ios/PokerLearner.xcodeproj
ARCHIVE=~/Desktop/PokerLearner.xcarchive
EXPORT=~/Desktop/PokerLearner_export

echo "=== Step 1: Archive ==="
xcodebuild archive \
  -project "$PROJECT" \
  -scheme PokerLearner \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER=PokerLearner_AppStore \
  DEVELOPMENT_TEAM=7Z2ZRB6V2J

echo "=== Step 2: ExportOptions.plist ==="
cat > ~/Desktop/ExportOptions.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>teamID</key>
    <string>7Z2ZRB6V2J</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>signingCertificate</key>
    <string>Apple Distribution</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>com.shota.pokerlearner</key>
        <string>PokerLearner_AppStore</string>
    </dict>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>
EOF

echo "=== Step 3: Export IPA ==="
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist ~/Desktop/ExportOptions.plist

echo "=== Done! IPA is at $EXPORT ==="
ls "$EXPORT"
