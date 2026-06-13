import AppTrackingTransparency
import SwiftUI
import UIKit
import UserMessagingPlatform

@main
struct PokerLearnerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .onAppear {
                    Self.startConsentFlow()
                }
        }
    }

    // デバッグビルド時のみログを詳細出力
    init() {
        #if DEBUG
        print("[App] ⚠️ DEBUG BUILD — テスト広告IDを使用中")
        #endif
    }

    /// 起動後フロー: ATT許可ダイアログ → UMP同意 → 広告初期化
    /// ATT は「メインスレッド」かつ「アプリがactiveな状態」でなければダイアログが表示されない。
    /// 以前は UMP のコールバック（バックグラウンドスレッドの可能性）から直接呼んでいたため
    /// 表示されないことがあった。ここでメインスレッドで遅延実行して確実に表示する。
    @MainActor
    static func startConsentFlow() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            if #available(iOS 14, *) {
                ATTrackingManager.requestTrackingAuthorization { status in
                    print("[ATT] status = \(status.rawValue)")
                    Task { @MainActor in requestConsentAndInitializeAds() }
                }
            } else {
                Task { @MainActor in requestConsentAndInitializeAds() }
            }
        }
    }

    /// UMP 同意フロー → 完了後に AdManager を初期化
    @MainActor
    static func requestConsentAndInitializeAds() {
        ConsentInformation.shared.requestConsentInfoUpdate(with: nil) { error in
            if let error {
                print("[UMP] requestConsentInfoUpdate failed: \(error.localizedDescription)")
                Task { @MainActor in AdManager.shared.initializeAndLoad() }
                return
            }

            guard let rootVC = UIApplication.shared
                .connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first?.keyWindow?.rootViewController else {
                Task { @MainActor in AdManager.shared.initializeAndLoad() }
                return
            }

            ConsentForm.loadAndPresentIfRequired(from: rootVC) { formError in
                if let formError {
                    print("[UMP] loadAndPresentIfRequired error: \(formError.localizedDescription)")
                }
                print("[UMP] canRequestAds = \(ConsentInformation.shared.canRequestAds)")
                Task { @MainActor in AdManager.shared.initializeAndLoad() }
            }
        }
    }
}
