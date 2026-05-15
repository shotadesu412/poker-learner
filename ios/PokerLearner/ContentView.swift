import SwiftUI
import WebKit
import Network

struct ContentView: View {
    @StateObject private var storeKitManager = StoreKitManager()
    @State private var isLoading = true
    @State private var isOffline = false
    @State private var isConnected = false

    var body: some View {
        GeometryReader { _ in
            ZStack {
                Color(hex: "#0f0f1a").ignoresSafeArea(edges: .all)

                if isConnected {
                    WebView(
                        storeKitManager: storeKitManager,
                        onFinish: { isLoading = false },
                        onFail: { isLoading = false; isOffline = true }
                    )
                    .ignoresSafeArea(edges: .all)
                }

                if isOffline {
                    OfflineView(onRetry: checkConnectivityAndLoad)
                } else if isLoading {
                    SplashView()
                }
            }
        }
        .onAppear {
            checkConnectivityAndLoad()
        }
    }

    private func checkConnectivityAndLoad() {
        isLoading = true
        isOffline = false
        isConnected = false
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "NetworkMonitor")
        monitor.start(queue: queue)
        monitor.pathUpdateHandler = { path in
            DispatchQueue.main.async {
                if path.status != .satisfied {
                    isLoading = false
                    isOffline = true
                } else {
                    isConnected = true
                    // Renderのコールドスタート対策: 最大5秒でスプラッシュを強制終了
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                        if isLoading { isLoading = false }
                    }
                }
                monitor.cancel()
            }
        }
    }
}

// MARK: - Splash View

struct SplashView: View {
    var body: some View {
        ZStack {
            Color(hex: "#0f0f1a").ignoresSafeArea(edges: .all)
            VStack(spacing: 16) {
                Text("Poker Learner")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .foregroundColor(.white)
                Text("Loading...")
                    .font(.subheadline)
                    .foregroundColor(.gray)
            }
        }
    }
}

// MARK: - Offline View

struct OfflineView: View {
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            Color(hex: "#0f0f1a").ignoresSafeArea(edges: .all)
            VStack(spacing: 20) {
                Text("接続できません")
                    .font(.title2)
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                Text("インターネット接続を確認してください")
                    .font(.subheadline)
                    .foregroundColor(.gray)
                Button(action: onRetry) {
                    Text("再試行")
                        .foregroundColor(.white)
                        .padding(.horizontal, 32)
                        .padding(.vertical, 12)
                        .background(Color(hex: "#3b82f6"))
                        .cornerRadius(16)
                }
            }
        }
    }
}

// MARK: - WebView

struct WebView: UIViewRepresentable {
    let storeKitManager: StoreKitManager
    let onFinish: () -> Void
    let onFail: () -> Void

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "purchaseRequest")
        controller.add(context.coordinator, name: "restoreRequest")
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.customUserAgent = "Mozilla/5.0 PokerLearner-iOS"
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        webView.backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.1, alpha: 1)
        webView.isOpaque = false

        storeKitManager.webView = webView

        if let url = URL(string: "https://tcgsimulator.onrender.com/static/index.html") {
            webView.load(URLRequest(url: url))
        }

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(storeKitManager: storeKitManager, onFinish: onFinish, onFail: onFail)
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let storeKitManager: StoreKitManager
        let onFinish: () -> Void
        let onFail: () -> Void

        init(storeKitManager: StoreKitManager, onFinish: @escaping () -> Void, onFail: @escaping () -> Void) {
            self.storeKitManager = storeKitManager
            self.onFinish = onFinish
            self.onFail = onFail
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async { self.onFinish() }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async { self.onFail() }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async { self.onFail() }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let host = navigationAction.request.url?.host else {
                decisionHandler(.allow)
                return
            }
            if host == "tcgsimulator.onrender.com" {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            switch message.name {
            case "purchaseRequest":
                Task { await storeKitManager.purchase() }
            case "restoreRequest":
                Task { await storeKitManager.restore() }
            default:
                break
            }
        }
    }
}

// MARK: - Color Extension

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r, g, b: UInt64
        switch hex.count {
        case 6:
            (r, g, b) = (int >> 16, int >> 8 & 0xFF, int & 0xFF)
        default:
            (r, g, b) = (1, 1, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: 1
        )
    }
}
