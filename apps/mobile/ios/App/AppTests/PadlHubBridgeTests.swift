import Capacitor
import UIKit
import XCTest
@testable import App

final class PadlHubBridgeTests: XCTestCase {
  @MainActor
  func testViewportStaysInsideSafeAreaWithoutDuplicateScrollInsets() throws {
    let controller = PadlHubBridgeViewController()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    window.rootViewController = controller
    controller.loadViewIfNeeded()
    controller.additionalSafeAreaInsets = UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0)
    window.layoutIfNeeded()
    controller.view.layoutIfNeeded()
    let webView = try XCTUnwrap(controller.webView)
    XCTAssertFalse(webView === controller.view)
    XCTAssertEqual(webView.frame, controller.view.safeAreaLayoutGuide.layoutFrame)
    XCTAssertGreaterThanOrEqual(webView.frame.minY, 59)
    XCTAssertEqual(webView.scrollView.contentInsetAdjustmentBehavior, .never)
    XCTAssertEqual(webView.safeAreaInsets, .zero)

    // Rotation moves the cutout to the side. Constraints must follow without a fixed top value.
    window.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
    controller.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: 59, bottom: 21, right: 59)
    window.layoutIfNeeded()
    controller.view.layoutIfNeeded()
    XCTAssertEqual(webView.frame, controller.view.safeAreaLayoutGuide.layoutFrame)
    XCTAssertGreaterThanOrEqual(webView.frame.minX, 59)
    XCTAssertLessThanOrEqual(webView.frame.maxX, controller.view.bounds.maxX - 59)
  }

  @MainActor
  func testPrivateContentIsCoveredUntilApplicationBecomesActive() throws {
    let app = UIApplication.shared
    let delegate = try XCTUnwrap(app.delegate)
    let windows = app.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    XCTAssertFalse(windows.isEmpty)
    delegate.applicationWillResignActive?(app)
    delegate.applicationDidEnterBackground?(app)
    delegate.applicationWillEnterForeground?(app)
    for window in windows {
      let shields = window.subviews.filter { $0.accessibilityIdentifier == "padlhub-privacy-shield" }
      XCTAssertEqual(shields.count, 1)
      XCTAssertEqual(shields.first?.frame, window.bounds)
      XCTAssertTrue(shields.first?.isOpaque == true)
      XCTAssertTrue(window.subviews.last === shields.first)
    }
    delegate.applicationDidBecomeActive?(app)
    XCTAssertTrue(windows.allSatisfy { window in
      !window.subviews.contains { $0.accessibilityIdentifier == "padlhub-privacy-shield" }
    })
  }

  @MainActor
  func testRunningAppRegistersNativeSessionBridgeAndDisablesCredentialLogging() throws {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    let controller = try XCTUnwrap(
      windows.compactMap { $0.rootViewController as? CAPBridgeViewController }.first)
    let bridge = try XCTUnwrap(controller.bridge)
    let plugin = try XCTUnwrap(bridge.plugin(withName: "PadlHubSession") as? CAPBridgedPlugin)
    XCTAssertEqual(plugin.jsName, "PadlHubSession")
    XCTAssertFalse(bridge.config.loggingEnabled)
  }
}
