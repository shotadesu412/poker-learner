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
                print("[UMP] canRequestAds = \(ConsentInformation.shared.canRequestAds)")
                // 3. ATT許可ダイアログを表示（iOS 14+）
                // canRequestAds のチェックは行わず常に初期化する
                // （日本など非GDPR地域では常に広告リクエスト可能だが、
                //   UMP の初期化タイミングによっては false を返す場合があるため）
                if #available(iOS 14, *) {
                    ATTrackingManager.requestTrackingAuthorization { status in
                        print("[ATT] status = \(status.rawValue)")
                        Task { @MainActor in AdManager.shared.initializeAndLoad() }
                    }
                } else {
                    Task { @MainActor in AdManager.shared.initializeAndLoad() }
                }
            }
        }
    }
}
