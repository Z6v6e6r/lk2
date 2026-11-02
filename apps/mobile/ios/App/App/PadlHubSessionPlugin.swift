import Capacitor
import Foundation
import PadlHubSession
#if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST
import WebKit

#if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST
// This suite has no notification installation. Do not touch Keychain/APNs just to log out.
@objc(PadlHubB07UnsupportedPushPlugin)
final class PadlHubB07UnsupportedPushPlugin: CAPPlugin, CAPBridgedPlugin {
  let identifier = "PadlHubB07UnsupportedPushPlugin"
  let jsName = "PadlHubIOSPush"
  let pluginMethods: [CAPPluginMethod] = [
    "status", "registration", "activate", "suspend", "finishRevoke", "takeOpened",
  ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
  private var inactive: [String: Any] {
    ["installationId": "44444444-4444-4444-8444-444444444444",
      "pendingRevoke": false, "revokeCurrentAccount": false]
  }
  @objc func status(_ call: CAPPluginCall) {
    var result = inactive
    result["configured"] = false
    result["active"] = false
    result["state"] = "unsupported"
    call.resolve(result)
  }
  @objc func suspend(_ call: CAPPluginCall) { call.resolve(inactive) }
  @objc func takeOpened(_ call: CAPPluginCall) { call.resolve([:]) }
  @objc func registration(_ call: CAPPluginCall) { unavailable(call) }
  @objc func activate(_ call: CAPPluginCall) { unavailable(call) }
  @objc func finishRevoke(_ call: CAPPluginCall) { unavailable(call) }
  private func unavailable(_ call: CAPPluginCall) {
    call.reject("Notifications unavailable in synthetic DIRECT fixture", "NATIVE_PUSH_UNAVAILABLE")
  }
}
#endif
#endif

@objc(PadlHubSessionPlugin)
public final class PadlHubSessionPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "PadlHubSessionPlugin"
  public let jsName = "PadlHubSession"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "configuration", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
  ]
  private var transport: SessionTransport?
  private var settings: SessionConfiguration?

  public override func load() {
    #if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST
    // This explicitly compiled XCTest host cannot construct a network/Keychain transport.
    // AppTests supplies the existing injected transport after the WebKit egress gate.
    return
    #else
    do {
      let config = try SessionConfiguration(
        origin: getConfig().getString("apiBaseUrl") ?? "",
        tenant: getConfig().getString("tenantKey") ?? "",
        appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
          as? String ?? "development",
        appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0")
      settings = config
      transport = try SessionTransport(
        configuration: config, bundleID: Bundle.main.bundleIdentifier ?? "ru.padlhub.app")
    } catch {
      // No logging of cookie, phone, OTP, headers, response body or native errors.
    }
    #endif
  }

  #if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST
  // Swift-only, internal, absent from Release and from the Capacitor method table.
  func installDirectIntegrationTransport(_ value: SessionTransport, configuration: SessionConfiguration) {
    precondition(Bundle.allBundles.contains { $0.bundleURL.pathExtension == "xctest" })
    precondition((bridge?.viewController as? PadlHubBridgeViewController)?.directIntegrationEgressReady == true)
    settings = configuration
    transport = value
  }
  #endif

  @objc func configuration(_ call: CAPPluginCall) {
    guard let settings else {
      call.reject("Native session is unavailable", SessionFailure.configuration.rawValue)
      return
    }
    call.resolve([
      "apiBaseUrl": settings.origin, "tenantKey": settings.tenant,
      "appVersion": settings.appVersion, "appBuild": settings.appBuild,
    ])
  }

  @objc func request(_ call: CAPPluginCall) {
    // Keychain can be temporarily locked at launch. Retry initialization on the
    // next operation, preserving a recoverable state instead of misreporting config.
    #if !(DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST)
    if transport == nil, let settings {
      do {
        transport = try SessionTransport(
          configuration: settings, bundleID: Bundle.main.bundleIdentifier ?? "ru.padlhub.app")
      } catch {
        call.reject("Native storage is unavailable", SessionFailure.storage.rawValue)
        return
      }
    }
    #endif
    guard let transport, let name = call.getString("operation"),
      let operation = SessionOperation(rawValue: name),
      let headers = call.getObject("headers") as? [String: String]
    else {
      call.reject("Native request is unavailable", SessionFailure.request.rawValue)
      return
    }
    var tournamentChat: TournamentChatRequest?
    if operation == .tournamentChat {
      guard Set(call.options.keys).isSubset(of:Set(["operation","resource","resourceId","requestId","query","headers","body"])),
        let resource=call.getString("resource"), let id=call.getString("resourceId"), let query=call.getObject("query") as? [String:String],
        call.options["requestId"] == nil || call.options["requestId"] is String,
        call.options["body"] == nil || call.options["body"] is String
      else {call.reject("Native request is unavailable",SessionFailure.request.rawValue);return}
      tournamentChat=TournamentChatRequest(resource:resource,tournamentID:id,requestID:call.getString("requestId"),query:query)
    }
    var stationStream: StationStreamRequest?
    if operation == .stationStream {
      guard Set(call.options.keys).isSubset(of:Set(["operation","resource","resourceId","requestId","query","headers","body"])),
        let resource=call.getString("resource"), let query=call.getObject("query") as? [String:String],
        call.options["resourceId"] == nil || call.options["resourceId"] is String,
        call.options["requestId"] == nil || call.options["requestId"] is String,
        call.options["body"] == nil || call.options["body"] is String
      else {call.reject("Native request is unavailable",SessionFailure.request.rawValue);return}
      stationStream=StationStreamRequest(resource:resource,communityID:call.getString("resourceId"),requestID:call.getString("requestId"),query:query)
    }
    var stationMessage: StationMessageRequest?
    if operation == .stationMessage {
      guard Set(call.options.keys).isSubset(of:Set(["operation","resource","resourceId","requestId","query","headers","body"])),
        let resource=call.getString("resource"), let id=call.getString("resourceId"),
        let query=call.getObject("query") as? [String:String],
        call.options["requestId"] == nil || call.options["requestId"] is String,
        call.options["body"] == nil || call.options["body"] is String
      else {call.reject("Native request is unavailable",SessionFailure.request.rawValue);return}
      stationMessage=StationMessageRequest(resource:resource,communityID:id,requestID:call.getString("requestId"),query:query)
    }
    var gameCancel: GameCancelRequest?
    if operation == .gameCancel {
      guard Set(call.options.keys).isSubset(of: Set(["operation","resourceId","headers","body"])),
        let id = call.getString("resourceId"), call.options["body"] is String
      else {call.reject("Native request is unavailable",SessionFailure.request.rawValue);return}
      gameCancel = GameCancelRequest(gameID:id)
    }
    var quarter: QuarterCreateRequest?
    if operation == .quarterCreate {
      let allowed = Set(["operation","resource","resourceId","headers","body"])
      guard Set(call.options.keys).isSubset(of:allowed), let resource = call.getString("resource"),
        (call.options["resourceId"] == nil || call.options["resourceId"] is String),
        (call.options["body"] == nil || call.options["body"] is String)
      else {call.reject("Native request is unavailable",SessionFailure.request.rawValue);return}
      quarter = QuarterCreateRequest(resource:resource,operationID:call.getString("resourceId"))
    }
    var read: CabinetRead?
    if operation == .read {
      guard let name = call.getString("resource"), let resource = CabinetResource(rawValue: name),
        let query = call.getObject("query") as? [String: String]
      else {
        call.reject("Native read is unavailable", SessionFailure.request.rawValue)
        return
      }
      read = CabinetRead(resource: resource, id: call.getString("resourceId"), query: query)
    }
    var tournament: TournamentRequest?
    if operation == .tournament {
      let allowed: Set<String> = ["operation", "resource", "resourceId", "operationId", "query", "headers", "body"]
      guard Set(call.options.keys).isSubset(of: allowed), let resource = call.getString("resource"),
        let query = call.getObject("query") as? [String: String],
        call.options["resourceId"] == nil || call.getString("resourceId") != nil,
        call.options["operationId"] == nil || call.getString("operationId") != nil,
        call.options["body"] == nil || call.getString("body") != nil
      else { call.reject("Native tournament request is unavailable", SessionFailure.request.rawValue); return }
      tournament = TournamentRequest(resource: resource, id: call.getString("resourceId"), operationID: call.getString("operationId"), query: query)
    }
    let notification = operation == .notification ? NotificationCommand(resource:call.getString("resource") ?? "",id:call.getString("resourceId")) : nil
    let messaging = operation == .messaging ? MessagingCommand(resource: call.getString("resource") ?? "", id: call.getString("resourceId")) : nil
    let request = SessionRequest(
      operation: operation, challengeID: call.getString("challengeId"),
      headers: headers, body: call.getString("body"), read: read, notification: notification, quarterCreate: quarter, gameCancel: gameCancel, stationMessage: stationMessage, stationStream: stationStream, tournamentChat: tournamentChat, tournament: tournament, messaging: messaging)
    Task {
      do {
        let response = try await transport.request(request)
        call.resolve([
          "status": response.status, "headers": response.headers, "body": response.body,
        ])
      } catch {
        let failure = error as? SessionFailure ?? .storage
        call.reject("Native session request failed", failure.rawValue)
      }
    }
  }
}

@objc(PadlHubBridgeViewController)
final class PadlHubBridgeViewController: CAPBridgeViewController {
  #if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST
  private(set) var directIntegrationEgressReady = false

  override func viewDidLoad() {
    // CAPBridgeViewController's super implementation performs the first web load.
    // Do not call it until the content blocker is installed. Failure stays blank.
    // WebKit content filters accept a strict regex subset, without alternation.
    // Keep each network scheme literal so compilation cannot reject a JS-only operator.
    let rules = #"[{"trigger":{"url-filter":"^http://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ws://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss://"},"action":{"type":"block"}}]"#
    WKContentRuleListStore.default().compileContentRuleList(
      forIdentifier: "padlhub-b07-test-egress-deny", encodedContentRuleList: rules
    ) { [weak self] list, error in
      guard let self, error == nil, let list else { return }
      self.webView?.configuration.userContentController.add(list)
      // Content rules are not a WebSocket guarantee. Disable that constructor before
      // any frame's scripts; product realtime receives a disabled ticket fixture.
      self.webView?.configuration.userContentController.addUserScript(WKUserScript(
        source: "Object.defineProperty(globalThis, 'WebSocket', {value: class { constructor() { throw new Error('B07_TEST_EGRESS_DENIED'); } }, writable: false, configurable: false});",
        injectionTime: .atDocumentStart, forMainFrameOnly: false))
      self.directIntegrationEgressReady = true
      self.loadDirectIntegrationWebView()
    }
  }

  private func loadDirectIntegrationWebView() {
    precondition(directIntegrationEgressReady)
    super.viewDidLoad()
  }
  #endif

  private var containedTop: NSLayoutConstraint?
  private var underlayTop: NSLayoutConstraint?
  private var underlap = false
  private var lastPublishedTop: CGFloat = -1
  let statusBarScrim = UIView()
  var onViewportInsetsChanged: ((CGFloat) -> Void)?

  override func capacitorDidLoad() {
    bridge?.registerPluginInstance(PadlHubSessionPlugin())
    #if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST
    bridge?.registerPluginInstance(PadlHubB07UnsupportedPushPlugin())
    #else
    bridge?.registerPluginInstance(PadlHubIOSPushPlugin())
    #endif
    bridge?.registerPluginInstance(PadlHubViewportPlugin())
    // Contain the viewport itself so scrolling and position:fixed cannot cover system UI.
    guard let webView else { return }
    let container = UIView(frame: webView.frame)
    container.backgroundColor = UIColor(red: 251 / 255, green: 251 / 255, blue: 250 / 255, alpha: 1)
    view = container
    container.addSubview(webView)
    webView.translatesAutoresizingMaskIntoConstraints = false
    let safeArea = container.safeAreaLayoutGuide
    containedTop = webView.topAnchor.constraint(equalTo: safeArea.topAnchor)
    underlayTop = webView.topAnchor.constraint(equalTo: container.topAnchor)
    NSLayoutConstraint.activate([
      containedTop!,
      webView.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: safeArea.bottomAnchor),
    ])
    statusBarScrim.accessibilityIdentifier = "phub-status-bar-scrim"
    // Match the sticky Home tabs (#9474ff); scrolling cards must not show through.
    statusBarScrim.backgroundColor = UIColor(red: 148 / 255, green: 116 / 255, blue: 1, alpha: 1)
    statusBarScrim.isOpaque = true
    statusBarScrim.isUserInteractionEnabled = false
    statusBarScrim.isAccessibilityElement = false
    statusBarScrim.isHidden = true
    container.addSubview(statusBarScrim)
    statusBarScrim.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      statusBarScrim.topAnchor.constraint(equalTo: container.topAnchor),
      statusBarScrim.bottomAnchor.constraint(equalTo: safeArea.topAnchor),
      statusBarScrim.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
      statusBarScrim.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor),
    ])
    statusBarStyle = .darkContent
  }

  var statusBarContentInset: CGFloat { underlap ? view.safeAreaInsets.top : 0 }

  func setStatusBarUnderlap(_ enabled: Bool) {
    underlap = enabled
    if let containedTop, let underlayTop {
      NSLayoutConstraint.deactivate([containedTop, underlayTop])
      NSLayoutConstraint.activate([enabled ? underlayTop : containedTop])
    }
    statusBarScrim.isHidden = !enabled
    view.setNeedsLayout()
    view.layoutIfNeeded()
    publishViewportInsets()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    publishViewportInsets()
  }

  private func publishViewportInsets() {
    let top = statusBarContentInset
    guard top != lastPublishedTop else { return }
    lastPublishedTop = top
    onViewportInsetsChanged?(top)
  }
}

// Presentation-only plugin on Capacitor's existing bridge; session transport is unchanged.
@objc(PadlHubViewportPlugin)
final class PadlHubViewportPlugin: CAPPlugin, CAPBridgedPlugin {
  let identifier = "PadlHubViewportPlugin"
  let jsName = "PadlHubViewport"
  let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "setUnderlap", returnType: CAPPluginReturnPromise)]

  override func load() {
    (bridge?.viewController as? PadlHubBridgeViewController)?.onViewportInsetsChanged = { [weak self] top in
      self?.notifyListeners("insetsChanged", data: ["top": Double(top)], retainUntilConsumed: true)
    }
  }

  @objc func setUnderlap(_ call: CAPPluginCall) {
    guard let enabled = call.getBool("enabled") else {
      call.reject("Viewport setting is required")
      return
    }
    DispatchQueue.main.async { [weak self] in
      guard let controller = self?.bridge?.viewController as? PadlHubBridgeViewController else {
        call.reject("Viewport is unavailable")
        return
      }
      controller.setStatusBarUnderlap(enabled)
      call.resolve(["top": Double(controller.statusBarContentInset)])
    }
  }
}
