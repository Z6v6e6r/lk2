import Capacitor
import PadlHubSession
import Security
import UIKit
import UserNotifications

private typealias IOSPushState = NotificationInstallationState
private final class IOSPushJournal {
  private let service: String
  init(scope: String) {
    service = (Bundle.main.bundleIdentifier ?? "ru.padlhub.app") + ".push." + scope
  }
  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "installation",
    ]
  }
  func read() throws -> IOSPushState {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound {
      let state = IOSPushState()
      try write(state)
      return state
    }
    guard status == errSecSuccess, let data = result as? Data,
      let state = try? JSONDecoder().decode(IOSPushState.self, from: data),
      UUID(uuidString: state.installationId) != nil
    else { throw SessionPushFailure.storage }
    return state
  }
  func write(_ state: IOSPushState) throws {
    let data = try JSONEncoder().encode(state)
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var q = query
      q[kSecValueData as String] = data
      q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else {
        throw SessionPushFailure.storage
      }
    } else if status != errSecSuccess {
      throw SessionPushFailure.storage
    }
  }
}
private enum SessionPushFailure: Error { case storage, unavailable, denied }

// AppDelegate forwards only the APNs token. Notification payload text is never exposed to JS.
final class PadlHubIOSPushHub: NSObject, UNUserNotificationCenterDelegate {
  static let shared = PadlHubIOSPushHub()
  fileprivate var journal: IOSPushJournal?
  fileprivate var configured = false
  fileprivate var scope = ""
  fileprivate func account() throws -> String {
    guard
      let hash = try NotificationAccountStore.current(
        bundleID: Bundle.main.bundleIdentifier ?? "ru.padlhub.app", scope: scope)
    else { throw SessionPushFailure.unavailable }
    return hash
  }
  private var opened = false
  private var openedAccount: String?
  func registered(_ data: Data) {
    guard let journal, configured else { return }
    do {
      var state = try journal.read()
      guard state.enabled, state.registrationAccount == ((try? account())) else { return }
      let token = data.map { String(format: "%02x", $0) }.joined()
      let prior = state.token
      try state.receiveToken(token, account: account())
      if prior != token {
        try journal.write(state)
        NotificationCenter.default.post(
          name: Notification.Name("phubAPNsRegistrationChanged"), object: nil)
      }
    } catch { /* Locked Keychain is recoverable; never log device tokens. */  }
  }
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    // Opens the authenticated inbox only, regardless of untrusted push userInfo.
    opened = true
    openedAccount = (try? journal?.read())?.activeAccount
    NotificationCenter.default.post(name: Notification.Name("phubAPNsOpened"), object: nil)
    completionHandler()
  }
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) { completionHandler([.banner, .sound]) }
  fileprivate func takeOpened() -> Bool {
    let result = opened && openedAccount != nil && openedAccount == (try? account())
    opened = false
    openedAccount = nil
    return result
  }
}

@objc(PadlHubIOSPushPlugin)
public final class PadlHubIOSPushPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "PadlHubIOSPushPlugin"
  public let jsName = "PadlHubIOSPush"
  public let pluginMethods: [CAPPluginMethod] = [
    "status", "registration", "activate", "suspend", "finishRevoke", "takeOpened",
  ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
  private var observers: [NSObjectProtocol] = []
  public override func load() {
    let hub = PadlHubIOSPushHub.shared
    // Separate native build gate: signing/capability acceptance remains an owner operation.
    hub.configured = getConfig().getBoolean("enabled", false)
    let session = getConfig().getString("scope") ?? ""
    if !session.isEmpty {
      hub.scope = session
      hub.journal = IOSPushJournal(scope: session)
    } else {
      hub.configured = false
    }
    UNUserNotificationCenter.current().delegate = hub
    for (name, event) in [
      ("phubAPNsRegistrationChanged", "registrationChanged"),
      ("phubAPNsOpened", "notificationOpened"),
    ] {
      observers.append(
        NotificationCenter.default.addObserver(
          forName: Notification.Name(name), object: nil, queue: .main
        ) { [weak self] _ in self?.notifyListeners(event, data: [:]) })
    }
  }
  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
  private func journal() throws -> IOSPushJournal {
    guard let journal = PadlHubIOSPushHub.shared.journal else {
      throw SessionPushFailure.unavailable
    }
    return journal
  }
  private func reject(_ call: CAPPluginCall, _ error: Error) {
    call.reject(
      "Notifications unavailable",
      error as? SessionPushFailure == .denied
        ? "NATIVE_PUSH_PERMISSION_DENIED" : "NATIVE_PUSH_UNAVAILABLE")
  }
  private func pending(_ state: IOSPushState) -> [String: Any] {
    let account = try? PadlHubIOSPushHub.shared.account()
    let revoke = state.pending(account: account)
    var value: [String: Any] = [
      "installationId": state.installationId, "pendingRevoke": revoke != nil,
      "revokeCurrentAccount": revoke != nil && revoke?.account == account,
    ]
    if let revoke { value["idempotencyKey"] = revoke.key }
    return value
  }

  @objc func status(_ call: CAPPluginCall) {
    Task { @MainActor in
      do {
        let state = try journal().read()
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let allowed =
          settings.authorizationStatus == .authorized
          || settings.authorizationStatus == .provisional
        var result = pending(state)
        result["configured"] = PadlHubIOSPushHub.shared.configured
        result["active"] = state.isActive(try? PadlHubIOSPushHub.shared.account())
        result["state"] =
          !PadlHubIOSPushHub.shared.configured
          ? "unsupported"
          : settings.authorizationStatus == .denied
            ? "denied"
            : state.enabled && allowed
              && (state.registrationAccount == (try? PadlHubIOSPushHub.shared.account())
                || state.activeAccount == (try? PadlHubIOSPushHub.shared.account()))
              ? "subscribed" : "prompt"
        call.resolve(result)
      } catch { reject(call, error) }
    }
  }
  @objc func registration(_ call: CAPPluginCall) {
    Task { @MainActor in
      do {
        guard PadlHubIOSPushHub.shared.configured else { throw SessionPushFailure.unavailable }
        let journal = try journal()
        var state = try journal.read()
        let account = try PadlHubIOSPushHub.shared.account()
        let epoch = state.epoch
        guard state.revokeKey == nil || state.revokeAccount != account else {
          throw SessionPushFailure.unavailable
        }
        if call.getBool("requestPermission") == true {
          guard
            try await UNUserNotificationCenter.current().requestAuthorization(options: [
              .alert, .badge, .sound,
            ])
          else { throw SessionPushFailure.denied }
          guard try PadlHubIOSPushHub.shared.account() == account,
            (try journal.read()).epoch == epoch
          else { throw SessionPushFailure.unavailable }
          state.enabled = true
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard
          state.enabled
            && (settings.authorizationStatus == .authorized
              || settings.authorizationStatus == .provisional)
        else { throw SessionPushFailure.denied }
        guard try PadlHubIOSPushHub.shared.account() == account, (try journal.read()).epoch == epoch
        else { throw SessionPushFailure.unavailable }
        try state.prepareRegistration(account: account, expectedEpoch: epoch)
        try journal.write(state)
        UIApplication.shared.registerForRemoteNotifications()
        for _ in 0..<100 {
          let current = try journal.read()
          let actualAccount = try PadlHubIOSPushHub.shared.account()
          guard
            current.enabled && current.registrationAccount == account && actualAccount == account
              && (current.revokeKey == nil || current.revokeAccount != account)
          else { throw SessionPushFailure.unavailable }
          if let token = current.token, let key = current.registrationKey {
            call.resolve([
              "installationId": current.installationId, "token": token, "idempotencyKey": key,
            ])
            return
          }
          try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw SessionPushFailure.unavailable
      } catch { reject(call, error) }
    }
  }
  @objc func activate(_ call: CAPPluginCall) {
    Task { @MainActor in
      do {
        let journal = try journal()
        var state = try journal.read()
        guard state.enabled, let account = try? PadlHubIOSPushHub.shared.account(),
          state.registrationAccount == account,
          state.revokeKey == nil || state.revokeAccount != account,
          let key = call.getString("idempotencyKey"), key == state.registrationKey,
          let endpoint = call.getString("endpointId"), UUID(uuidString: endpoint) != nil
        else { throw SessionPushFailure.unavailable }
        try state.activate(key: key, endpointId: endpoint, account: account)
        try journal.write(state)
        call.resolve()
      } catch { reject(call, error) }
    }
  }
  @objc func suspend(_ call: CAPPluginCall) {
    Task { @MainActor in
      do {
        let journal = try journal()
        var state = try journal.read()
        state.suspend(account: try? PadlHubIOSPushHub.shared.account())
        try journal.write(state)
        UIApplication.shared.unregisterForRemoteNotifications()
        call.resolve(pending(state))
      } catch { reject(call, error) }
    }
  }
  @objc func finishRevoke(_ call: CAPPluginCall) {
    Task { @MainActor in
      do {
        let journal = try journal()
        var state = try journal.read()
        guard let key = call.getString("idempotencyKey"),
          let account = try? PadlHubIOSPushHub.shared.account(),
          state.pending(account: account)?.key == key, state.revokeCurrentAccount(account)
        else { throw SessionPushFailure.unavailable }
        try state.finishRevoke(key: key, account: account)
        try journal.write(state)
        call.resolve()
      } catch { reject(call, error) }
    }
  }
  @objc func takeOpened(_ call: CAPPluginCall) {
    Task { @MainActor in
      call.resolve(PadlHubIOSPushHub.shared.takeOpened() ? ["route": "/notifications"] : [:])
    }
  }
}
