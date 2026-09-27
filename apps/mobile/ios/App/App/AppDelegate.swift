import UIKit
import Capacitor

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var privacyShields: [UIView] = []

    private func coverPrivateContent(_ application: UIApplication) {
        guard privacyShields.isEmpty else { return }
        var windows = application.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        if let window, !windows.contains(where: { $0 === window }) { windows.append(window) }
        for window in windows {
            let shield = UIView(frame: window.bounds)
            shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            shield.backgroundColor = UIColor(red: 0.984, green: 0.984, blue: 0.98, alpha: 1)
            shield.isOpaque = true
            shield.accessibilityIdentifier = "padlhub-privacy-shield"
            shield.isAccessibilityElement = true
            shield.accessibilityLabel = "ПадлХАБ"
            shield.accessibilityViewIsModal = true
            window.addSubview(shield)
            privacyShields.append(shield)
        }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Hide account content before iOS captures the app-switcher snapshot.
        coverPrivateContent(application)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        coverPrivateContent(application)
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        privacyShields.forEach { $0.removeFromSuperview() }
        privacyShields.removeAll()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
