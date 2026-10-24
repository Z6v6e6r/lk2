import Foundation
import XCTest

@testable import PadlHubSession

final class NotificationCommandTests: XCTestCase {
  func testFixedAuthenticatedNativeNotificationPaths() throws {
    let config = try SessionConfiguration(
      origin: "https://lk2.padlhub.su", tenant: "synthetic", appVersion: "test", appBuild: "1")
    let id = UUID().uuidString
    let command = NotificationCommand(resource: "pushRegister")
    let body = "{\"installationId\":\"\(id)\",\"token\":\"\(String(repeating:"a",count:64))\"}"
    let request = try SessionRequest(
      operation: .notification,
      headers: [
        "Authorization": "Bearer synthetic", "Idempotency-Key": "synthetic-registration-key",
      ], body: body, notification: command
    ).urlRequest(configuration: config)
    XCTAssertEqual(
      request.url?.absoluteString,
      "https://lk2.padlhub.su/user/api/v1/synthetic/notification-endpoints/ios")
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertThrowsError(
      try SessionRequest(operation: .notification, headers: [:], body: body, notification: command)
        .urlRequest(configuration: config))
    XCTAssertThrowsError(
      try NotificationCommand(resource: "https://evil.invalid").path(configuration: config))
    XCTAssertThrowsError(
      try NotificationCommand(resource: "pushRevoke", id: "../other").path(configuration: config))
    XCTAssertThrowsError(
      try NotificationCommand(resource: "pushRegister").validatedBody("{\"token\":\"invalid\"}"))
  }
  func testNotificationReadsCannotChooseAnotherTenant() throws {
    let config = try SessionConfiguration(
      origin: "https://lk2.padlhub.su", tenant: "synthetic", appVersion: "test", appBuild: "1")
    XCTAssertEqual(
      try CabinetRead(resource: .notifications, query: ["unreadOnly": "true", "limit": "20"]).url(
        configuration: config
      ).path, "/user/api/v1/synthetic/notifications")
    XCTAssertThrowsError(
      try CabinetRead(resource: .notifications, query: ["tenant": "other"]).url(
        configuration: config))
    XCTAssertThrowsError(
      try CabinetRead(resource: .pushConfig, query: ["url": "https://evil.invalid"]).url(
        configuration: config))
  }
}
