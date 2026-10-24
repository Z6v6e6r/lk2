import Foundation

/// Native-only identity derived from a validated PadlHub session response. Never accepts a JS account id.
public enum NotificationAccountStore {
  public static func current(bundleID: String, scope: String) throws -> String? {
    let store = try KeychainCredentialStore(bundleID: bundleID, scope: scope)
    guard let saved = try store.read(), saved.scope == scope, saved.expiresAt > Date(),
      saved.logoutKey == nil, let hash = saved.accountHash,
      hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    else { return nil }
    return hash
  }
}
