import Combine
import StoreKit
import WebKit

private let productID = "com.shota.pokerlearner.premium.monthly"

@MainActor
final class StoreKitManager: ObservableObject {
    static let shared = StoreKitManager()

    weak var webView: WKWebView?
    private var products: [Product] = []
    private var displayPrice: String?
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
                if let product = products.first {
                    displayPrice = product.displayPrice
                    pushPrice()
                }
                return
            } catch {
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: 3_000_000_000) // 3秒待ってリトライ
                }
            }
        }
    }

    /// 購入モーダルの価格表示を更新する（モーダルを開いたときにJSから呼ばれる）
    func pushPrice() {
        if let price = displayPrice {
            let js = "(function(){var el=document.getElementById('purchase-price-display');if(el)el.textContent='\(price) / 月';})()"
            sendJS(js)
        } else {
            // まだ価格を取得できていなければ再取得を試みる
            Task { await loadProducts() }
        }
    }

    // MARK: - Transaction Updates（サブスク更新・失効を検知）

    private func observeTransactionUpdates() async {
        for await result in Transaction.updates {
            if case .verified(let tx) = result {
                await tx.finish()
                if tx.productID == productID {
                    if tx.revocationDate == nil {
                        sendJS("window.onRestoreSuccess()")
                    } else {
                        // 返金・取り消し → プレミアム解除
                        sendJS("window.onEntitlementStatus && window.onEntitlementStatus(false)")
                    }
                }
            }
        }
    }

    // MARK: - Entitlements Check（起動時）

    /// StoreKit の実権利状態をJSへ通知する。
    /// 有効なサブスクがない場合も必ず false を通知し、サーバーDBに残った
    /// 古いプレミアム状態（解約後・期限切れ）をJS側で解除させる。
    func checkEntitlements() async {
        for await result in Transaction.currentEntitlements {
            if case .verified(let tx) = result, tx.productID == productID {
                sendJS("window.onEntitlementStatus ? window.onEntitlementStatus(true) : window.onRestoreSuccess()")
                return
            }
        }
        sendJS("window.onEntitlementStatus && window.onEntitlementStatus(false)")
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
        // 明示的な「購入を復元」: App Store と同期してから確認する。
        // これがないと機種変更後などの新端末で購入が見つからないことがある。
        try? await AppStore.sync()
        var found = false
        for await result in Transaction.currentEntitlements {
            if case .verified(let tx) = result, tx.productID == productID {
                found = true
                break
            }
        }
        sendJS(found
            ? "window.onRestoreSuccess()"
            : "window.onRestoreNotFound ? window.onRestoreNotFound() : window.onPurchaseCancel()")
    }

    // MARK: - JS Bridge

    private func sendJS(_ script: String) {
        guard let webView else { return }
        Task {
            try? await webView.evaluateJavaScript(script)
        }
    }
}
