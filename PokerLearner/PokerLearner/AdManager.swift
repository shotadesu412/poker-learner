import GoogleMobileAds
import UIKit
import WebKit

@MainActor
final class AdManager: NSObject, FullScreenContentDelegate {
    static let shared = AdManager()
    private let adUnitID = "ca-app-pub-2416149393168379/6297339288"
    private var interstitial: InterstitialAd?
    weak var webView: WKWebView?

    private override init() {
        super.init()
        MobileAds.initialize()
        preload()
    }

    func preload() {
        Task {
            do {
                interstitial = try await InterstitialAd.load(
                    with: adUnitID,
                    request: Request()
                )
                interstitial?.fullScreenContentDelegate = self
            } catch {
                interstitial = nil
            }
        }
    }

    func show() {
        guard let interstitial,
              let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.windows.first?.rootViewController else {
            dismiss()
            return
        }
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
