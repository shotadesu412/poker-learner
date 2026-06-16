import GoogleMobileAds
import UIKit
import WebKit

@MainActor
final class AdManager: NSObject, FullScreenContentDelegate {
    static let shared = AdManager()

    // デバッグビルドはGoogleテストIDを使用（本番では絶対に使わないこと）
    #if DEBUG
    private let rewardedAdUnitID = "ca-app-pub-3940256099942544/1712485313"      // Google公式テスト用リワード
    private let interstitialAdUnitID = "ca-app-pub-3940256099942544/4411468910"  // Google公式テスト用インタースティシャル
    #else
    private let rewardedAdUnitID = "ca-app-pub-2416149393168379/REWARDED_UNIT_ID" // 本番（AdMobでリワード広告ユニットを作成して差し替える）
    private let interstitialAdUnitID = "ca-app-pub-2416149393168379/6297339288"   // 本番インタースティシャル
    #endif

    private var rewarded: RewardedAd?
    private var interstitial: InterstitialAd?
    private var didEarnReward = false
    private var presentingRewarded = false
    weak var webView: WKWebView?

    private override init() {
        super.init()
        // MobileAds の初期化は UMP 同意取得後に initializeAndLoad() で行う
    }

    /// UMP 同意取得後に呼ぶ
    func initializeAndLoad() {
        MobileAds.initialize()
        preloadRewarded()
        preloadInterstitial()
    }

    // MARK: - Load

    func preloadRewarded() {
        Task {
            do {
                print("[Ad] Loading rewarded ad...")
                rewarded = try await RewardedAd.load(with: rewardedAdUnitID, request: Request())
                rewarded?.fullScreenContentDelegate = self
                print("[Ad] Rewarded ad loaded")
            } catch {
                print("[Ad] Failed to load rewarded ad: \(error.localizedDescription)")
                rewarded = nil
            }
        }
    }

    func preloadInterstitial() {
        Task {
            do {
                print("[Ad] Loading interstitial ad...")
                interstitial = try await InterstitialAd.load(with: interstitialAdUnitID, request: Request())
                interstitial?.fullScreenContentDelegate = self
                print("[Ad] Interstitial ad loaded")
            } catch {
                print("[Ad] Failed to load interstitial ad: \(error.localizedDescription)")
                interstitial = nil
            }
        }
    }

    // MARK: - Show

    /// リワード広告（AIコーチのゲート用）。ユーザーが視聴を選んだときのみ呼ぶ。
    func showRewarded() {
        guard let rewarded, let root = Self.rootViewController() else {
            print("[Ad] showRewarded: not ready — earned=false")
            notifyRewardDismissed(earned: false)
            return
        }
        print("[Ad] Presenting rewarded ad")
        presentingRewarded = true
        didEarnReward = false
        rewarded.present(from: root) { [weak self] in
            self?.didEarnReward = true
            print("[Ad] User earned reward")
        }
    }

    /// インタースティシャル広告（30ハンドごとの自動表示用）。
    func showInterstitial() {
        guard let interstitial, let root = Self.rootViewController() else {
            print("[Ad] showInterstitial: not ready — skip")
            preloadInterstitial()
            return
        }
        print("[Ad] Presenting interstitial ad")
        presentingRewarded = false
        interstitial.present(from: root)
    }

    // MARK: - Delegate

    nonisolated func adDidDismissFullScreenContent(_ ad: FullScreenPresentingAd) {
        Task { @MainActor in
            if self.presentingRewarded {
                self.notifyRewardDismissed(earned: self.didEarnReward)
            } else {
                self.preloadInterstitial()
            }
        }
    }

    nonisolated func ad(_ ad: FullScreenPresentingAd, didFailToPresentFullScreenContentWithError error: Error) {
        Task { @MainActor in
            if self.presentingRewarded {
                self.notifyRewardDismissed(earned: false)
            } else {
                self.preloadInterstitial()
            }
        }
    }

    // MARK: - Helpers

    private func notifyRewardDismissed(earned: Bool) {
        sendJS("window.onAdDismissed(\(earned ? "true" : "false"))")
        preloadRewarded()
    }

    private static func rootViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return nil }
        return scene.keyWindow?.rootViewController
    }

    private func sendJS(_ script: String) {
        guard let webView else { return }
        Task { try? await webView.evaluateJavaScript(script) }
    }
}
