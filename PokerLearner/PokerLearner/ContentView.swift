import Combine
import SwiftUI
import UIKit
import WebKit
import Network

private let renderURL = URL(string: "https://tcgsimulator.onrender.com/static/index.html")!

@MainActor
final class WebViewModel: ObservableObject {
    @Published var isOffline = false
    @Published var isLoaded = false
    var webView: WKWebView?
    private var timeoutTask: Task<Void, Never>?

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
        isLoaded = false
        start()
    }

    func startTimeout() {
        timeoutTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if !Task.isCancelled { isLoaded = true }
        }
    }

    func didFinishLoading() {
        timeoutTask?.cancel()
        isLoaded = true
        Task { await StoreKitManager.shared.checkEntitlements() }
    }

    func didFailLoading() {
        timeoutTask?.cancel()
        isLoaded = true
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
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) PokerLearner-iOS"
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
            if viewModel.isOffline {
                OfflineView { viewModel.retry() }
            } else {
                WebViewContainer(viewModel: viewModel)
                    .ignoresSafeArea(.all)
                    .opacity(viewModel.isLoaded ? 1 : 0)
            }
        }
        .onAppear { viewModel.start() }
    }
}

private struct OfflineView: View {
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            Color(red: 15 / 255, green: 15 / 255, blue: 26 / 255).ignoresSafeArea()
            VStack(spacing: 24) {
                Text("インターネット接続がありません")
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
