import XCTest

@testable import PadlHubSession

final class NotificationInstallationTests: XCTestCase {
  func testLogoutTombstoneRejectsLateEnableAndActivation() throws {
    var state = NotificationInstallationState()
    let epoch = state.epoch
    state.suspend(account: "account-a")
    state.enabled = true
    XCTAssertThrowsError(try state.prepareRegistration(account: "account-a", expectedEpoch: epoch))
    XCTAssertTrue(state.revokeCurrentAccount("account-a"))
    XCTAssertThrowsError(
      try state.activate(key: "late", endpointId: UUID().uuidString, account: "account-a"))
  }
  func testOtherAccountCannotClearThePreviousRevoke() throws {
    var state = NotificationInstallationState()
    state.enabled = true
    try state.prepareRegistration(account: "account-a", expectedEpoch: 0)
    try state.receiveToken(String(repeating: "a", count: 64), account: "account-a")
    try state.activate(
      key: state.registrationKey!, endpointId: UUID().uuidString, account: "account-a")
    state.suspend(account: nil)
    let pending = state.revokeKey!
    XCTAssertFalse(state.revokeCurrentAccount("account-b"))
    XCTAssertThrowsError(try state.finishRevoke(key: pending, account: "account-b"))
    XCTAssertEqual(state.revokeKey, pending)
    // Only acknowledged server ownership transfer may retire the old pending account.
    state.enabled = true
    try state.prepareRegistration(account: "account-b", expectedEpoch: state.epoch)
    XCTAssertNotNil(state.revokeKey)
    try state.activate(
      key: state.registrationKey!, endpointId: UUID().uuidString, account: "account-b")
    XCTAssertTrue(state.isActive("account-b"))
    XCTAssertFalse(state.isActive("account-a"))
    XCTAssertNil(state.revokeKey)
  }
  func testTokenRotationAndDurableReplayFence() throws {
    var state = NotificationInstallationState()
    state.enabled = true
    try state.prepareRegistration(account: "a", expectedEpoch: 0)
    try state.receiveToken(String(repeating: "a", count: 64), account: "a")
    let prior = state.registrationKey!
    try state.receiveToken(String(repeating: "b", count: 64), account: "a")
    XCTAssertNotEqual(state.registrationKey, prior)
    XCTAssertThrowsError(
      try state.activate(key: prior, endpointId: UUID().uuidString, account: "a"))
    state.suspend(account: "a")
    let data = try JSONEncoder().encode(state)
    var restored = try JSONDecoder().decode(NotificationInstallationState.self, from: data)
    XCTAssertFalse(restored.enabled)
    XCTAssertTrue(restored.revokeCurrentAccount("a"))
    XCTAssertThrowsError(try restored.receiveToken(String(repeating: "c", count: 64), account: "a"))
    try restored.finishRevoke(key: restored.revokeKey!, account: "a")
    XCTAssertNil(restored.revokeKey)
  }
  func testFailedTransferDuringSecondLogoutRetainsBothRevokeIntents() throws {
    var state = NotificationInstallationState()
    state.enabled = true
    try state.prepareRegistration(account: "a", expectedEpoch: 0)
    try state.activate(key: state.registrationKey!, endpointId: UUID().uuidString, account: "a")
    state.suspend(account: "a")
    let old = state.pending(account: "a")!.key
    state.enabled = true
    try state.prepareRegistration(account: "b", expectedEpoch: state.epoch)
    state.suspend(account: "b")
    XCTAssertEqual(state.pending(account: "a")?.key, old)
    XCTAssertTrue(state.revokeCurrentAccount("b"))
    let current = state.pending(account: "b")!.key
    try state.finishRevoke(key: current, account: "b")
    XCTAssertEqual(state.pending(account: "a")?.key, old)
    XCTAssertFalse(state.revokeCurrentAccount("b"))
    XCTAssertFalse(state.enabled)
  }

}
