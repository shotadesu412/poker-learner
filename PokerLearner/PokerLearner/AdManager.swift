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
    private var rewardedLoadedAt: Date?
    private var interstitialLoadedAt: Date?
    private var rewardedLoadTask: Task<RewardedAd?, Never>?
    private var interstitialLoadTask: Task<InterstitialAd?, Never>?
    private var didEarnReward = false
    private var presentingRewarded = false
    weak var webView: WKWebView?

    /// AdMobの広告は約1時間で失効するため、余裕をもって55分で作り直す
    private let adTTL: TimeInterval = 55 * 60

    private func isFresh(_ loadedAt: Date?) -> Bool {
        guard let loadedAt else { return false }
        return Date().timeIntervalSince(loadedAt) < adTTL
    }

    private override init() {
        super.init()
        // MobileAds の初期化は UMP 同意取得後に initializeAndLoad() で行う
    }

    /// UMP 同意取得後に呼ぶ。SDKの起動のみ行い、広告のロードはしない。
    /// 広告は表示が近づいたタイミングでJSから prepare 系メッセージが来たときに
    /// ロードする（起動ごとの無駄なリクエストで表示率が下がるのを防ぐ）。
    func initializeAndLoad() {
        // 注意: MobileAds.initialize() は NSObject の +initialize が解決されるだけで
        // SDK は起動しない。必ず shared.start() を使うこと。
        MobileAds.shared.start { status in
            let states = status.adapterStatusesByClassName
                .map { "\($0.key)=\($0.value.state.rawValue)" }
                .joined(separator: ", ")
            print("[Ad] MobileAds started: \(states)")
        }
    }

    // MARK: - Load（表示直前にJSからの prepare で呼ばれる）

    /// コーチ制限モーダルが開いたときに呼ばれる。ロード済み・ロード中なら何もしない。
    func preloadRewarded() {
        if rewarded != nil && isFresh(rewardedLoadedAt) { return }
        if rewardedLoadTask != nil { return }
        rewarded = nil
        print("[Ad] Loading rewarded ad...")
        let task = Task { () -> RewardedAd? in
            do {
                let ad = try await RewardedAd.load(with: rewardedAdUnitID, request: Request())
                print("[Ad] Rewarded ad loaded")
                return ad
            } catch {
                print("[Ad] Failed to load rewarded ad: \(error.localizedDescription)")
                return nil
            }
        }
        rewardedLoadTask = task
        Task {
            let ad = await task.value
            ad?.fullScreenContentDelegate = self
            self.rewarded = ad
            self.rewardedLoadedAt = ad != nil ? Date() : nil
            self.rewardedLoadTask = nil
        }
    }

    /// 25ハンド目（表示5ハンド前）にJSから呼ばれる。ロード済み・ロード中なら何もしない。
    func preloadInterstitial() {
        if interstitial != nil && isFresh(interstitialLoadedAt) { return }
        if interstitialLoadTask != nil { return }
        interstitial = nil
        print("[Ad] Loading interstitial ad...")
        let task = Task { () -> InterstitialAd? in
            do {
                let ad = try await InterstitialAd.load(with: interstitialAdUnitID, request: Request())
                print("[Ad] Interstitial ad loaded")
                return ad
            } catch {
                print("[Ad] Failed to load interstitial ad: \(error.localizedDescription)")
                return nil
            }
        }
        interstitialLoadTask = task
        Task {
            let ad = await task.value
            ad?.fullScreenContentDelegate = self
            self.interstitial = ad
            self.interstitialLoadedAt = ad != nil ? Date() : nil
            self.interstitialLoadTask = nil
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
        // 準備済み（失効前）ならそのまま表示
        if let rewarded, isFresh(rewardedLoadedAt) {
            presentRewarded(rewarded, from: root)
            return
        }
        Task {
            // prepare によるロードが進行中なら完了を待つ（二重リクエスト防止）
            var ad: RewardedAd?
            if let task = rewardedLoadTask {
                ad = await task.value
            }
            // それでも無ければ最後の手段としてその場でロード
            if ad == nil {
                print("[Ad] Rewarded not ready — loading on demand...")
                ad = try? await RewardedAd.load(with: rewardedAdUnitID, request: Request())
            }
            if let ad {
                ad.fullScreenContentDelegate = self
                self.rewarded = ad
                self.rewardedLoadedAt = Date()
                self.presentRewarded(ad, from: root)
            } else {
                print("[Ad] Rewarded unavailable")
                self.notifyRewardUnavailable()
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
    /// 未準備・失効時はスキップ（ゲーム進行を止めない）。次の prepare で再ロードされる。
    func showInterstitial() {
        guard let interstitial, isFresh(interstitialLoadedAt),
              let root = Self.rootViewController() else {
            print("[Ad] showInterstitial: not ready — skip")
            return
        }
        print("[Ad] Presenting interstitial ad")
        presentingRewarded = false
        interstitial.present(from: root)
        self.interstitial = nil
        self.interstitialLoadedAt = nil
    }

    // MARK: - Delegate

    nonisolated func adDidDismissFullScreenContent(_ ad: FullScreenPresentingAd) {
        Task { @MainActor in
            if self.presentingRewarded {
                self.notifyRewardDismissed(earned: self.didEarnReward)
            }
            // 次の広告は必要になったタイミングの prepare でロードする（先読みしない）
        }
    }

    nonisolated func ad(_ ad: FullScreenPresentingAd, didFailToPresentFullScreenContentWithError error: Error) {
        Task { @MainActor in
            if self.presentingRewarded {
                self.rewarded = nil
                self.rewardedLoadedAt = nil
                self.notifyRewardUnavailable()
            } else {
                self.interstitial = nil
                self.interstitialLoadedAt = nil
            }
        }
    }

    // MARK: - Helpers

    /// ユーザーが広告を閉じた（earned=最後まで視聴したか）
    private func notifyRewardDismissed(earned: Bool) {
        rewarded = nil
        rewardedLoadedAt = nil
        sendJS("window.onAdDismissed(\(earned ? "true" : "false"))")
    }

    /// 広告を用意できなかった（在庫なし/通信障害/表示失敗）。
    /// JS側でエラーメッセージを表示し、ゲートは通過させない（フェイルクローズ）。
    private func notifyRewardUnavailable() {
        sendJS("window.onAdUnavailable && window.onAdUnavailable()")
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
