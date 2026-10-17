import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    // Push: Capacitor's push plugin only *listens* for these notifications; the
    // app delegate has to post them, or registration never completes and no
    // device token ever reaches the web app.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // Universal Links (https://officialfriendly.com/...) and custom-scheme opens
    // are forwarded to the App plugin, which raises `appUrlOpen` in the web app.
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}

// The app's one screen: Capacitor's web view, plus the iOS edge swipe for Back.
// The site is a single page that moves between screens with #/ links, and WebKit
// keeps each of those in its back list, so the swipe walks back screen by screen.
class FriendlyViewController: CAPBridgeViewController {
    private var pageGuard: PageGuard?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
        // Sit between WebKit and Capacitor's own delegate so a killed page shows "Reconnecting" at once (see PageGuard).
        if let wv = webView, let original = wv.navigationDelegate as? (NSObject & WKNavigationDelegate) {
            let g = PageGuard(original: original, host: view)
            pageGuard = g
            wv.navigationDelegate = g
        }
    }
}

// iOS kills the web page's process to get memory back (while the app is in the background, or when a system
// screen such as the contacts permission comes up over it). Capacitor reloads the page, but until the reload
// paints, the person is left looking at the bare background and taps do nothing. This guard:
//  - shows a native "Reconnecting" screen the instant the page dies, and hides it once the page has loaded;
//  - offers "Try again" if the reload has not finished within a few seconds (no signal, say);
//  - tells the reloaded page it was killed (window.__killedReloadAt), so the site can put the person back
//    where they were instead of guessing from timing.
// Everything else WebKit asks the delegate goes straight through to Capacitor's handler.
final class PageGuard: NSObject, WKNavigationDelegate {
    private weak var original: (NSObject & WKNavigationDelegate)?
    private weak var host: UIView?
    private weak var webView: WKWebView?
    private var overlay: UIView?
    private var retryButton: UIButton?
    private var retryTimer: Timer?

    init(original: NSObject & WKNavigationDelegate, host: UIView) {
        self.original = original
        self.host = host
        super.init()
        // At launch, keep the launch image up until the page has painted: otherwise the bare background shows for
        // the second it takes the web view to start up and fetch the page.
        showOverlay(reconnecting: false)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        if super.responds(to: aSelector) { return true }
        return original?.responds(to: aSelector) ?? false
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? { original }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        self.webView = webView
        showOverlay(reconnecting: true)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: "window.__killedReloadAt = \(stamp);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        original?.webViewWebContentProcessDidTerminate?(webView)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        original?.webView?(webView, didCommit: navigation)
        // The page's HTML has arrived; its inline logo paints at once, so the cover can go.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.hideOverlay() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        original?.webView?(webView, didFinish: navigation)
        hideOverlay()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        original?.webView?(webView, didFail: navigation, withError: error)
        if overlay != nil { showRetry() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        original?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        if overlay != nil { showRetry() }
    }

    // MARK: - the Reconnecting screen (the launch image, a spinner under the logo, and after 8 seconds a Try again button)

    private func showOverlay(reconnecting: Bool) {
        guard overlay == nil, let host = host else { return }
        // The launch image (the logo on its gradient), so this reads as the app coming back, not an error screen.
        let v = UIImageView(frame: host.bounds)
        v.image = UIImage(named: "Splash")
        v.contentMode = .scaleAspectFill
        v.clipsToBounds = true
        v.isUserInteractionEnabled = true
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.startAnimating()
        spinner.isHidden = !reconnecting
        let label = UILabel()
        label.text = "Reconnecting…"
        label.isHidden = !reconnecting
        label.textColor = .white
        label.font = .systemFont(ofSize: 17, weight: .semibold)
        let button = UIButton(type: .system)
        button.setTitle("Try again", for: .normal)
        button.setTitleColor(UIColor(red: 0.165, green: 0.125, blue: 0.098, alpha: 1), for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
        button.backgroundColor = .white
        button.layer.cornerRadius = 22
        button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 26, bottom: 12, right: 26)
        button.isHidden = true
        button.addTarget(self, action: #selector(retry), for: .touchUpInside)
        retryButton = button

        let stack = UIStackView(arrangedSubviews: [spinner, label, button])
        stack.axis = .vertical; stack.alignment = .center; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: v.centerXAnchor),
                                     stack.topAnchor.constraint(equalTo: v.centerYAnchor, constant: 110)])   // below the logo
        host.addSubview(v)
        overlay = v
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in self?.showRetry() }
    }

    private func showRetry() {
        retryButton?.isHidden = false
    }

    private func hideOverlay() {
        retryTimer?.invalidate(); retryTimer = nil
        guard let v = overlay else { return }
        overlay = nil
        UIView.animate(withDuration: 0.3, animations: { v.alpha = 0 }, completion: { _ in v.removeFromSuperview() })
    }

    @objc private func retry() {
        retryButton?.isHidden = true
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in self?.showRetry() }
        webView?.reload()
    }
}
