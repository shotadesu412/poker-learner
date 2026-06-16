import GoogleMobileAds
import UIKit
import WebKit

@MainActor
final class AdManager: NSObject, FullScreenContentDelegate {
    static let shared = AdManager()

    // デバッグビルドはGoogleテストIDを使用（本番では絶対に使わないこと）
    #if DEBUG
    private let adUnitID = "ca-app-pub-3940256099942544/1712485313"  // Google公式テスト用リワード
    #else
    private let adUnitID = "ca-app-pub-2416149393168379/REWARDED_UNIT_ID"  // 本番（AdMobでリワード広告ユニットを作成して差し替える）
    #endif

    private var rewarded: RewardedAd?
    private var didEarnReward = false
    weak var webView: WKWebView?

    private override init() {
        super.init()
        // MobileAds の初期化は UMP 同意取得後に initializeAndLoad() で行う
    }

    /// UMP 同意取得後に呼ぶ
    func initializeAndLoad() {
        MobileAds.initialize()
        preload()
    }

    func preload() {
        Task {
            do {
                print("[Ad] Loading rewarded ad...")
                rewarded = try await RewardedAd.load(
                    with: adUnitID,
                    request: Request()
                )
                rewarded?.fullScreenContentDelegate = self
                print("[Ad] Rewarded ad loaded successfully")
            } catch {
                print("[Ad] Failed to load rewarded ad: \(error.localizedDescription)")
                rewarded = nil
            }
        }
    }

    func show() {
        guard let rewarded else {
            print("[Ad] show() called but no ad loaded — earned=false")
            dismiss(earned: false)
            return
        }
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.keyWindow?.rootViewController else {
            print("[Ad] show() called but no root view controller")
            dismiss(earned: false)
            return
        }
        print("[Ad] Presenting rewarded ad")
        didEarnReward = false
        rewarded.present(from: root) { [weak self] in
            // ユーザーが最後まで視聴して報酬を獲得
            self?.didEarnReward = true
            print("[Ad] User earned reward")
        }
    }

    /// 広告終了時にJSへ通知（earned: 最後まで視聴したか）
    private func dismiss(earned: Bool) {
        sendJS("window.onAdDismissed(\(earned ? "true" : "false"))")
        preload()
    }

    nonisolated func adDidDismissFullScreenContent(_ ad: FullScreenPresentingAd) {
        Task { @MainActor in self.dismiss(earned: self.didEarnReward) }
    }

    nonisolated func ad(_ ad: FullScreenPresentingAd, didFailToPresentFullScreenContentWithError error: Error) {
        Task { @MainActor in self.dismiss(earned: false) }
    }

    private func sendJS(_ script: String) {
        guard let webView else { return }
        Task { try? await webView.evaluateJavaScript(script) }
    }
}
