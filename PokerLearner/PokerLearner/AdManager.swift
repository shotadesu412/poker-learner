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
    private let rewardedAdUnitID = "ca-app-pub-2416149393168379/9738839934"      // 本番リワード
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
        guard let root = Self.rootViewController() else {
            print("[Ad] showRewarded: no root — unavailable")
            notifyRewardUnavailable()
            return
        }
        // プリロード済みならそのまま表示。未ロードならその場で読み込んでから表示。
        if let rewarded {
            presentRewarded(rewarded, from: root)
        } else {
            print("[Ad] Rewarded not preloaded — loading on demand...")
            Task {
                do {
                    let ad = try await RewardedAd.load(with: rewardedAdUnitID, request: Request())
                    ad.fullScreenContentDelegate = self
                    self.rewarded = ad
                    self.presentRewarded(ad, from: root)
                } catch {
                    // 広告在庫なし/通信障害: ユーザー都合ではないため閉じ込めず通過させる
                    print("[Ad] On-demand rewarded load failed: \(error.localizedDescription) — unavailable")
                    self.notifyRewardUnavailable()
                }
            }
        }
    }

    private func presentRewarded(_ ad: RewardedAd, from root: UIViewController) {
        print("[Ad] Presenting rewarded ad")
        presentingRewarded = true
        didEarnReward = false
        ad.present(from: root) { [weak self] in
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
                // 表示自体の失敗（SDK都合）もユーザー都合ではない → 通過させる
                self.notifyRewardUnavailable()
            } else {
                self.preloadInterstitial()
            }
        }
    }

    // MARK: - Helpers

    /// ユーザーが広告を閉じた（earned=最後まで視聴したか）
    private func notifyRewardDismissed(earned: Bool) {
        sendJS("window.onAdDismissed(\(earned ? "true" : "false"))")
        preloadRewarded()
    }

    /// 広告を用意できなかった（在庫なし/通信障害/表示失敗）。
    /// ユーザー都合ではないためJS側でゲートを通過させる。
    private func notifyRewardUnavailable() {
        sendJS("window.onAdUnavailable && window.onAdUnavailable()")
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
