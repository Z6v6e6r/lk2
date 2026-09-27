import Capacitor
import UIKit
import XCTest

final class PadlHubBridgeTests: XCTestCase {
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
