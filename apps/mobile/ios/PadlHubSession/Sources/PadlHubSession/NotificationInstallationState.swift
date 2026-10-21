import Foundation

public enum NotificationInstallationFailure: Error { case stale }
/// APNs installation journal. Accounts are native session fingerprints, never WebView input.
public struct NotificationInstallationState: Codable {
  public var installationId = UUID().uuidString.lowercased()
  public var enabled = false
  public var active = false
  public var token: String?
  public var registrationKey: String?
  public var revokeKey: String?
  public var registrationAccount: String?
  public var activeAccount: String?
  public var revokeAccount: String?
  public var deferredRevokes: [String: String] = [:]
  public var epoch = 0
  public init() {}
  public func revokeCurrentAccount(_ account: String?) -> Bool {
    account != nil
      && ((revokeKey != nil && revokeAccount == account) || deferredRevokes[account!] != nil)
  }
  public func isActive(_ account: String?) -> Bool {
    active && !revokeCurrentAccount(account) && activeAccount != nil && activeAccount == account
  }
  public func pending(account: String?) -> (key: String, account: String)? {
    if let account, let key = deferredRevokes[account] { return (key, account) }
    if let key = revokeKey, let account = revokeAccount { return (key, account) }
    if let account = deferredRevokes.keys.sorted().first, let key = deferredRevokes[account] {
      return (key, account)
    }
    return nil
  }
  public mutating func prepareRegistration(account: String, expectedEpoch: Int) throws {
    guard enabled, epoch == expectedEpoch, !revokeCurrentAccount(account) else {
      throw NotificationInstallationFailure.stale
    }
    if registrationAccount != account { registrationKey = nil }
    registrationAccount = account
    registrationKey = registrationKey ?? UUID().uuidString.lowercased()
  }
  public mutating func receiveToken(_ token: String, account: String) throws {
    guard enabled, registrationAccount == account, !revokeCurrentAccount(account) else {
      throw NotificationInstallationFailure.stale
    }
    if self.token != token {
      self.token = token
      registrationKey = UUID().uuidString.lowercased()
      active = false
    }
  }
  public mutating func activate(key: String, endpointId: String, account: String) throws {
    guard enabled, !revokeCurrentAccount(account), registrationAccount == account,
      registrationKey == key, UUID(uuidString: endpointId) != nil
    else { throw NotificationInstallationFailure.stale }
    if let prior = revokeAccount, let key = revokeKey, prior != account {
      deferredRevokes[prior] = key
    }
    active = true
    activeAccount = account
    registrationKey = nil
    revokeKey = nil
    revokeAccount = nil
  }
  public mutating func suspend(account: String?) {
    let target = registrationAccount ?? activeAccount ?? account
    if let prior = revokeAccount, let key = revokeKey, prior != target {
      deferredRevokes[prior] = key
    }
    if revokeKey == nil || revokeAccount != target {
      revokeKey = UUID().uuidString.lowercased()
      revokeAccount = target
    }
    epoch += 1
    enabled = false
    active = false
    registrationKey = nil
  }
  public mutating func finishRevoke(key: String, account: String) throws {
    if deferredRevokes[account] == key {
      deferredRevokes.removeValue(forKey: account)
      return
    }
    guard revokeKey == key, revokeAccount == account else {
      throw NotificationInstallationFailure.stale
    }
    revokeKey = nil
    revokeAccount = nil
  }
}
