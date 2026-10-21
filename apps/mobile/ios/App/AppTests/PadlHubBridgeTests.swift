import Capacitor
import UIKit
import XCTest
@testable import App

final class PadlHubBridgeTests: XCTestCase {
  @MainActor
  func testViewportStaysInsideSafeAreaWithoutDuplicateScrollInsets() throws {
    // A detached UIWindow has no scene geometry; exercise the displayed application instead.
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    let controller = try XCTUnwrap(
      windows.compactMap { $0.rootViewController as? PadlHubBridgeViewController }.first)
    let originalInsets = controller.additionalSafeAreaInsets
    defer {
      controller.setStatusBarUnderlap(false)
      controller.additionalSafeAreaInsets = originalInsets
      controller.view.setNeedsLayout()
      controller.view.layoutIfNeeded()
    }
    controller.additionalSafeAreaInsets = UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0)
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    let webView = try XCTUnwrap(controller.webView)
    XCTAssertFalse(webView === controller.view)
    XCTAssertEqual(webView.frame, controller.view.safeAreaLayoutGuide.layoutFrame)
    XCTAssertGreaterThanOrEqual(webView.frame.minY, 59)
    XCTAssertEqual(webView.scrollView.contentInsetAdjustmentBehavior, .never)
    XCTAssertEqual(webView.safeAreaInsets, .zero)

    controller.setStatusBarUnderlap(true)
    XCTAssertEqual(webView.frame.minY, 0)
    XCTAssertEqual(webView.frame.maxY, controller.view.safeAreaLayoutGuide.layoutFrame.maxY)
    XCTAssertEqual(controller.statusBarScrim.frame.height, controller.view.safeAreaInsets.top)
    XCTAssertFalse(controller.statusBarScrim.isHidden)
    XCTAssertEqual(controller.statusBarScrim.backgroundColor,
      UIColor(red: 148 / 255, green: 116 / 255, blue: 1, alpha: 1))
    XCTAssertTrue(controller.statusBarScrim.isOpaque)
    XCTAssertFalse(controller.statusBarScrim.isUserInteractionEnabled)
    XCTAssertFalse(controller.statusBarScrim.isAccessibilityElement)
    XCTAssertEqual(controller.statusBarContentInset, controller.view.safeAreaInsets.top)
    XCTAssertEqual(webView.scrollView.contentInsetAdjustmentBehavior, .never)

    // Model side cutouts after rotation. Constraints must follow without a fixed top value.
    controller.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: 59, bottom: 21, right: 59)
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    XCTAssertEqual(webView.frame.minY, 0)
    XCTAssertEqual(controller.statusBarScrim.frame.height, controller.view.safeAreaInsets.top)
    XCTAssertGreaterThanOrEqual(webView.frame.minX, 59)
    XCTAssertLessThanOrEqual(webView.frame.maxX, controller.view.bounds.maxX - 59)
    controller.setStatusBarUnderlap(false)
    XCTAssertEqual(webView.frame, controller.view.safeAreaLayoutGuide.layoutFrame)
    XCTAssertTrue(controller.statusBarScrim.isHidden)
    XCTAssertEqual(controller.statusBarContentInset, 0)
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
    XCTAssertNotNil(bridge.plugin(withName: "PadlHubViewport"))
  }
}
