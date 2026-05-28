import Combine
import StoreKit
import WebKit

private let productID = "com.shota.pokerlearner.premium.monthly"

@MainActor
final class StoreKitManager: ObservableObject {
    static let shared = StoreKitManager()

    weak var webView: WKWebView?
    private var products: [Product] = []
    private var updatesTask: Task<Void, Never>?

    private init() {
        Task { await loadProducts() }
        // サブスク更新・失効・他デバイス購入をリアルタイム検知
        updatesTask = Task { await observeTransactionUpdates() }
    }

    // MARK: - Product Loading（失敗時リトライ）

    private func loadProducts() async {
        for attempt in 1...3 {
            do {
                products = try await Product.products(for: [productID])
                return
            } catch {
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: 3_000_000_000) // 3秒待ってリトライ
                }
            }
        }
    }

    // MARK: - Transaction Updates（サブスク更新・失効を検知）

    private func observeTransactionUpdates() async {
        for await result in Transaction.updates {
            if case .verified(let tx) = result {
                await tx.finish()
                if tx.productID == productID && tx.revocationDate == nil {
                    sendJS("window.onRestoreSuccess()")
                }
            }
        }
    }

    // MARK: - Entitlements Check（起動時）

    func checkEntitlements() async {
        for await result in Transaction.currentEntitlements {
            if case .verified(let tx) = result, tx.productID == productID {
                sendJS("window.onRestoreSuccess()")
                return
            }
        }
    }

    // MARK: - Purchase

    func purchase() async {
        if products.isEmpty { await loadProducts() }
        guard let product = products.first else {
            sendJS("window.onPurchaseCancel()")
            return
        }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                guard case .verified(let tx) = verification else {
                    sendJS("window.onPurchaseCancel()")
                    return
                }
                await tx.finish()
                sendJS("window.onPurchaseSuccess({\"productId\":\"\(tx.productID)\",\"transactionId\":\"\(tx.id)\"})")
            case .userCancelled, .pending:
                sendJS("window.onPurchaseCancel()")
            @unknown default:
                sendJS("window.onPurchaseCancel()")
            }
        } catch {
            sendJS("window.onPurchaseCancel()")
        }
    }

    // MARK: - Restore

    func restore() async {
        var found = false
        for await result in Transaction.currentEntitlements {
            if case .verified(let tx) = result, tx.productID == productID {
                found = true
                break
            }
        }
        sendJS(found ? "window.onRestoreSuccess()" : "window.onPurchaseCancel()")
    }

    // MARK: - JS Bridge

    private func sendJS(_ script: String) {
        guard let webView else { return }
        Task {
            try? await webView.evaluateJavaScript(script)
        }
    }
}
