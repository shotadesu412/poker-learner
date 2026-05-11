import Foundation
import StoreKit
import WebKit

@MainActor
class StoreKitManager: ObservableObject {
    weak var webView: WKWebView?
    private(set) var product: Product?

    private let productID = "com.shota.pokerlearner.premium.monthly"

    init() {
        Task {
            await loadProducts()
            await checkExistingEntitlements()
        }
    }

    private func loadProducts() async {
        do {
            let products = try await Product.products(for: [productID])
            product = products.first
        } catch {
            print("Failed to load products: \(error)")
        }
    }

    private func checkExistingEntitlements() async {
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result,
               transaction.productID == productID,
               transaction.revocationDate == nil {
                sendJS("window.onRestoreSuccess && window.onRestoreSuccess()")
                return
            }
        }
    }

    func purchase() async {
        guard let product = product else { return }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                if case .verified(let transaction) = verification {
                    await transaction.finish()
                    let js = """
                    window.onPurchaseSuccess && window.onPurchaseSuccess({
                        "productId": "\(productID)",
                        "transactionId": "\(transaction.id)"
                    })
                    """
                    sendJS(js)
                }
            case .userCancelled:
                sendJS("window.onPurchaseCancel && window.onPurchaseCancel()")
            case .pending:
                break
            @unknown default:
                break
            }
        } catch {
            sendJS("window.onPurchaseCancel && window.onPurchaseCancel()")
        }
    }

    func restore() async {
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result,
               transaction.productID == productID,
               transaction.revocationDate == nil {
                sendJS("window.onRestoreSuccess && window.onRestoreSuccess()")
                return
            }
        }
        sendJS("window.onPurchaseCancel && window.onPurchaseCancel()")
    }

    private func sendJS(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}
