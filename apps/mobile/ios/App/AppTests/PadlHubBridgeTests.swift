import Capacitor
import UIKit
import XCTest

final class PadlHubBridgeTests: XCTestCase {
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
