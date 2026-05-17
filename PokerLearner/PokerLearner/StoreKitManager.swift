import Combine
import StoreKit
import WebKit

private let productID = "com.shota.pokerlearner.premium.monthly"

@MainActor
final class StoreKitManager: ObservableObject {
    static let shared = StoreKitManager()

    weak var webView: WKWebView?
    private var products: [Product] = []

    private init() {
        Task {
            do {
                products = try await Product.products(for: [productID])
            } catch {}
        }
    }

    func checkEntitlements() async {
        for await result in Transaction.currentEntitlements {
            if case .verified(let tx) = result, tx.productID == productID {
                sendJS("window.onRestoreSuccess()")
                return
            }
        }
    }

    func purchase() async {
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

    private func sendJS(_ script: String) {
        guard let webView else { return }
        Task {
            try? await webView.evaluateJavaScript(script)
        }
    }
}
