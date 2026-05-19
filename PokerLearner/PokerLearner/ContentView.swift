import Combine
import SwiftUI
import UIKit
import WebKit
import Network

private let renderURL = URL(string: "https://tcgsimulator.onrender.com/static/index.html")!

@MainActor
final class WebViewModel: ObservableObject {
    @Published var isOffline = false
    @Published var loadState: LoadState = .loading
    var webView: WKWebView?
    private var timeoutTask: Task<Void, Never>?

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
        loadState = .loading
        isOffline = false
        webView?.load(URLRequest(url: renderURL))
        startTimeout()
        start()
    }

    func startTimeout() {
        timeoutTask?.cancel()
        timeoutTask = Task {
            try? await Task.sleep(nanoseconds: 90_000_000_000) // 90 seconds
            if !Task.isCancelled && loadState == .loading {
                loadState = .failed
            }
        }
    }

    func didFinishLoading() {
        timeoutTask?.cancel()
        loadState = .loaded
        Task { await StoreKitManager.shared.checkEntitlements() }
    }

    func didFailLoading() {
        timeoutTask?.cancel()
        loadState = .failed
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

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.1, alpha: 1)
        webView.isOpaque = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator

        viewModel.webView = webView
        StoreKitManager.shared.webView = webView

        webView.load(URLRequest(url: renderURL))
        viewModel.startTimeout()
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

            // WebView は常に裏で読み込み続ける
            if !viewModel.isOffline {
                WebViewContainer(viewModel: viewModel)
                    .ignoresSafeArea(.all)
                    .opacity(viewModel.loadState == .loaded ? 1 : 0)
            }

            // ローディング中はスプラッシュ表示
            if viewModel.loadState == .loading && !viewModel.isOffline {
                SplashView()
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
    var body: some View {
        ZStack {
            Color(red: 0.06, green: 0.06, blue: 0.1).ignoresSafeArea()
            VStack(spacing: 32) {
                VStack(spacing: 8) {
                    Text("ポーカー")
                        .font(.system(size: 36, weight: .bold))
                        .foregroundColor(.white)
                    + Text("ラッシュ")
                        .font(.system(size: 36, weight: .bold))
                        .foregroundColor(Color(red: 0.23, green: 0.72, blue: 0.51))
                    Text("Poker Strategy Training")
                        .font(.system(size: 14))
                        .foregroundColor(Color.white.opacity(0.5))
                }
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    .scaleEffect(1.2)
                Text("読み込み中...")
                    .font(.system(size: 13))
                    .foregroundColor(Color.white.opacity(0.4))
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
