import SwiftUI
import UserMessagingPlatform

@main
struct PokerLearnerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .onAppear {
                    requestConsentAndInitializeAds()
                }
        }
    }

    /// UMP 同意フロー → 完了後に AdManager を初期化
    private func requestConsentAndInitializeAds() {
        // 1. 同意情報を更新（EEA/UK かどうかを判定）
        ConsentInformation.shared.requestConsentInfoUpdate(with: nil) { error in
            if let error {
                print("[UMP] requestConsentInfoUpdate failed: \(error.localizedDescription)")
                AdManager.shared.initializeAndLoad()
                return
            }

            // 2. 必要であれば同意フォームを表示
            guard let rootVC = UIApplication.shared
                .connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first?.keyWindow?.rootViewController else {
                AdManager.shared.initializeAndLoad()
                return
            }

            ConsentForm.loadAndPresentIfRequired(from: rootVC) { formError in
                if let formError {
                    print("[UMP] loadAndPresentIfRequired error: \(formError.localizedDescription)")
                }
                // 3. 同意済み or 不要なら広告初期化
                if ConsentInformation.shared.canRequestAds {
                    AdManager.shared.initializeAndLoad()
                }
            }
        }
    }
}
