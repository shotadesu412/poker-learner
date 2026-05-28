import AppTrackingTransparency
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
    @MainActor
    private func requestConsentAndInitializeAds() {
        // 1. 同意情報を更新（EEA/UK かどうかを判定）
        ConsentInformation.shared.requestConsentInfoUpdate(with: nil) { error in
            if let error {
                print("[UMP] requestConsentInfoUpdate failed: \(error.localizedDescription)")
                Task { @MainActor in AdManager.shared.initializeAndLoad() }
                return
            }

            // 2. 必要であれば同意フォームを表示
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
                // 3. ATT許可ダイアログを表示（iOS 14+）
                if #available(iOS 14, *) {
                    ATTrackingManager.requestTrackingAuthorization { _ in
                        Task { @MainActor in
                            if ConsentInformation.shared.canRequestAds {
                                AdManager.shared.initializeAndLoad()
                            }
                        }
                    }
                } else {
                    Task { @MainActor in
                        if ConsentInformation.shared.canRequestAds {
                            AdManager.shared.initializeAndLoad()
                        }
                    }
                }
            }
        }
    }
}
