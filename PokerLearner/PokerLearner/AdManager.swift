import GoogleMobileAds
import UIKit
import WebKit

@MainActor
final class AdManager: NSObject, FullScreenContentDelegate {
    static let shared = AdManager()

    // デバッグビルドはGoogleテストIDを使用（本番では絶対に使わないこと）
    #if DEBUG
    private let adUnitID = "ca-app-pub-3940256099942544/4411468910"  // Google公式テスト用インタースティシャル
    #else
    private let adUnitID = "ca-app-pub-2416149393168379/6297339288"  // 本番
    #endif

    private var interstitial: InterstitialAd?
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
                print("[Ad] Loading interstitial ad...")
                interstitial = try await InterstitialAd.load(
                    with: adUnitID,
                    request: Request()
                )
                interstitial?.fullScreenContentDelegate = self
                print("[Ad] Interstitial ad loaded successfully")
            } catch {
                print("[Ad] Failed to load interstitial ad: \(error.localizedDescription)")
                interstitial = nil
            }
        }
    }

    func show() {
        guard let interstitial else {
            print("[Ad] show() called but no ad loaded — calling dismiss()")
            dismiss()
            return
        }
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.keyWindow?.rootViewController else {
            print("[Ad] show() called but no root view controller")
            dismiss()
            return
        }
        print("[Ad] Presenting interstitial ad")
        interstitial.present(from: root)
    }

    private func dismiss() {
        sendJS("window.onAdDismissed()")
        preload()
    }

    nonisolated func adDidDismissFullScreenContent(_ ad: FullScreenPresentingAd) {
        Task { @MainActor in self.dismiss() }
    }

    nonisolated func ad(_ ad: FullScreenPresentingAd, didFailToPresentFullScreenContentWithError error: Error) {
        Task { @MainActor in self.dismiss() }
    }

    private func sendJS(_ script: String) {
        guard let webView else { return }
        Task { try? await webView.evaluateJavaScript(script) }
    }
}
