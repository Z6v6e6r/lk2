import Foundation
import Security

struct RefreshCredential: Codable, Equatable {
  let version: Int
  let scope: String
  let value: String
  let expiresAt: Date
  var refreshKey: String?
  var logoutKey: String?
}

protocol CredentialStore {
  func read() throws -> RefreshCredential?
  func write(_ credential: RefreshCredential) throws
  func clear() throws
}

final class KeychainCredentialStore: CredentialStore {
  private let service: String
  private let scope: String

  init(bundleID: String, scope: String, defaults: UserDefaults = .standard) throws {
    self.service = "\(bundleID).padlhub-session.\(scope)"
    self.scope = scope
    // Keychain survives uninstall; the app's container does not. Never silently adopt
    // a prior installation's session when the app container has been removed.
    let marker = service + ".installed"
    if !defaults.bool(forKey: marker) {
      try clear()
      defaults.set(true, forKey: marker)
    }
  }

  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "phub_refresh",
      kSecAttrSynchronizable as String: false,
    ]
  }

  func read() throws -> RefreshCredential? {
    var query = query
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw SessionFailure.storage }
    guard let data = result as? Data,
      let record = try? JSONDecoder().decode(RefreshCredential.self, from: data),
      record.version == 1, record.scope == scope
    else {
      try clear()
      return nil
    }
    return record
  }

  func write(_ credential: RefreshCredential) throws {
    let attributes: [String: Any] = [
      kSecValueData as String: try JSONEncoder().encode(credential),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      let item = query.merging(attributes) { _, new in new }
      guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
        throw SessionFailure.storage
      }
    } else if status != errSecSuccess {
      throw SessionFailure.storage
    }
  }

  func clear() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw SessionFailure.storage
    }
  }
}
