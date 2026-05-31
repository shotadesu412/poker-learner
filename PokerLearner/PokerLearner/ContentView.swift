import Combine
import SwiftUI
import UIKit
import WebKit
import Network

private let renderURL = URL(string: "https://poker-learner.onrender.com/")!

@MainActor
final class WebViewModel: ObservableObject {
    @Published var isOffline = false
    @Published var loadState: LoadState = .loading
    @Published var isWarmingUp = false      // サーバー起動中メッセージ用
    @Published var isWebViewReady = false   // React描画完了後にtrueになる
    var webView: WKWebView?
    private var timeoutTask: Task<Void, Never>?
    private var warmUpTask: Task<Void, Never>?
    private var autoRetryCount = 0
    private let maxAutoRetries = 4

    enum LoadState { case loading, loaded, failed }

    func start() {
        Task {
            let connected = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                let monitor = NWPathMonitor()
                monitor.pathUpdateHandler = { path in
                    monitor.cancel()
                    cont.resume(returning: path.status == .satisfied)
                }
                monitor.start(queue: .global())
            }
            isOffline = !connected
        }
    }

    func retry() {
        autoRetryCount = 0
        loadState = .loading
        isWarmingUp = false
        isWebViewReady = false
        isOffline = false
        var request = URLRequest(url: renderURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        webView?.load(request)
        startTimeout()
        startWarmUpMessage()
        start()
    }

    func startTimeout() {
        timeoutTask?.cancel()
        timeoutTask = Task {
            try? await Task.sleep(nanoseconds: 180_000_000_000) // 180秒
            if !Task.isCancelled && loadState == .loading {
                loadState = .failed
            }
        }
    }

    /// 20秒後に「サーバー起動中」メッセージを表示
    func startWarmUpMessage() {
        warmUpTask?.cancel()
        warmUpTask = Task {
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            if !Task.isCancelled && loadState == .loading {
                isWarmingUp = true
            }
        }
    }

    func didFinishLoading() {
        timeoutTask?.cancel()
        warmUpTask?.cancel()
        autoRetryCount = 0
        isWarmingUp = false
        loadState = .loaded
        Task { await StoreKitManager.shared.checkEntitlements() }
        Task { await waitForReactRender() }
    }

    /// ReactのDOM描画を検知してからWebViewを表示（最大30秒）
    private func waitForReactRender() async {
        let js = "document.body?.innerHTML?.length ?? 0"
        for _ in 0..<60 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let wv = webView,
                  let result = try? await wv.evaluateJavaScript(js),
                  let length = result as? Int else { continue }
            if length > 300 {
                isWebViewReady = true
                return
            }
        }
        // 30秒経過でもとりあえず表示
        isWebViewReady = true
    }

    /// ロード失敗時：自動リトライ（コールドスタート対応）
    func didFailLoading() {
        if autoRetryCount < maxAutoRetries {
            autoRetryCount += 1
            Task {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                if loadState != .loaded {
                    webView?.load(URLRequest(url: renderURL))
                }
            }
        } else {
            timeoutTask?.cancel()
            warmUpTask?.cancel()
            isWarmingUp = false
            loadState = .failed
        }
    }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var coordinator: WebViewContainer.Coordinator?

    init(_ coordinator: WebViewContainer.Coordinator) {
        self.coordinator = coordinator
    }

    nonisolated func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        Task { @MainActor in
            if message.name == "purchaseRequest" {
                await StoreKitManager.shared.purchase()
            } else if message.name == "restoreRequest" {
                await StoreKitManager.shared.restore()
            } else if message.name == "showInterstitialAd" {
                AdManager.shared.show()
            }
        }
    }
}

struct WebViewContainer: UIViewRepresentable {
    let viewModel: WebViewModel

    func makeCoordinator() -> Coordinator { Coordinator(viewModel: viewModel) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let handler = WeakMessageHandler(context.coordinator)
        config.userContentController.add(handler, name: "purchaseRequest")
        config.userContentController.add(handler, name: "restoreRequest")
        config.userContentController.add(handler, name: "showInterstitialAd")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.1, alpha: 1)
        webView.isOpaque = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator

        viewModel.webView = webView
        StoreKitManager.shared.webView = webView
        AdManager.shared.webView = webView

        viewModel.startTimeout()
        viewModel.startWarmUpMessage()

        // キャッシュをクリアしてから最新のWebコンテンツを読み込む
        WKWebsiteDataStore.default().removeData(
            ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache],
            modifiedSince: .distantPast
        ) {
            DispatchQueue.main.async {
                var request = URLRequest(url: renderURL)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                webView.load(request)
            }
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let viewModel: WebViewModel
        init(viewModel: WebViewModel) { self.viewModel = viewModel }

        nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor [weak self] in self?.viewModel.didFinishLoading() }
        }

        nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor [weak self] in self?.viewModel.didFailLoading() }
        }

        nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor [weak self] in self?.viewModel.didFailLoading() }
        }
    }
}

struct ContentView: View {
    @StateObject private var viewModel = WebViewModel()

    var body: some View {
        ZStack {
            Color(red: 0.06, green: 0.06, blue: 0.1).ignoresSafeArea()

            // WebView は常にView階層に存在（isOfflineで消さない）
            WebViewContainer(viewModel: viewModel)
                .ignoresSafeArea(.all)
                .opacity(viewModel.isWebViewReady ? 1 : 0)
                .animation(.easeIn(duration: 0.4), value: viewModel.isWebViewReady)

            // ローディング中 or React描画待ちはスプラッシュ表示
            if !viewModel.isWebViewReady && viewModel.loadState != .failed {
                SplashView(isWarmingUp: viewModel.isWarmingUp)
            }

            // エラー・オフライン
            if viewModel.isOffline || viewModel.loadState == .failed {
                ErrorView(
                    message: viewModel.isOffline
                        ? "インターネット接続がありません"
                        : "読み込みに失敗しました\nしばらく経ってから再試行してください",
                    onRetry: { viewModel.retry() }
                )
            }
        }
        .onAppear { viewModel.start() }
    }
}

private struct SplashView: View {
    var isWarmingUp: Bool = false

    var body: some View {
        ZStack {
            Color(red: 0.06, green: 0.06, blue: 0.1).ignoresSafeArea()
            VStack(spacing: 32) {
                VStack(spacing: 8) {
                    HStack(spacing: 0) {
                        Text("ポーカー")
                            .font(.system(size: 36, weight: .bold))
                            .foregroundColor(.white)
                        Text("ラッシュ")
                            .font(.system(size: 36, weight: .bold))
                            .foregroundColor(Color(red: 0.23, green: 0.72, blue: 0.51))
                    }
                    Text("Poker Strategy Training")
                        .font(.system(size: 14))
                        .foregroundColor(Color.white.opacity(0.5))
                }
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    .scaleEffect(1.2)
                VStack(spacing: 8) {
                    Text(isWarmingUp ? "サーバー起動中..." : "読み込み中...")
                        .font(.system(size: 13))
                        .foregroundColor(Color.white.opacity(0.4))
                    if isWarmingUp {
                        Text("初回起動は少し時間がかかります")
                            .font(.system(size: 12))
                            .foregroundColor(Color.white.opacity(0.3))
                    }
                }
            }
        }
    }
}

private struct ErrorView: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            Color(red: 0.06, green: 0.06, blue: 0.1).ignoresSafeArea()
            VStack(spacing: 24) {
                Text(message)
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                Button(action: onRetry) {
                    Text("再試行")
                        .padding(.horizontal, 32)
                        .padding(.vertical, 12)
                        .background(Color.white.opacity(0.15))
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
            }
            .padding()
        }
    }
}

#Preview {
    ContentView()
}
