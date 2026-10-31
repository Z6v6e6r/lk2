#if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST
import Foundation
@testable import PadlHubSession

final class DirectIntegrationStore: CredentialStore {
  private let lock = NSLock()
  private var credential: RefreshCredential?
  func read() throws -> RefreshCredential? {
    lock.lock(); defer { lock.unlock() }; return credential
  }
  func write(_ value: RefreshCredential) throws {
    lock.lock(); defer { lock.unlock() }; credential = value
  }
  func clear() throws {
    lock.lock(); defer { lock.unlock() }; credential = nil
  }
}

// One synthetic DIRECT journey. There is no URLSession, disk credential, or fallback.
final class DirectIntegrationFixture {
  enum Mode { case success, lostResponse, offline, locked, wrongTarget, delayedProfile }
  struct Snapshot {
    let requests: [String]
    let createKeys: [String]
    let unexpected: [String]
    let completedProfiles: Int
  }
  let store = DirectIntegrationStore()
  let mode: Mode
  let peerID: String
  let directID: String
  let viewerID: String
  private let data: [String: Any]
  private let lock = NSLock()
  private var requests: [String] = []
  private var createKeys: [String] = []
  private var unexpected: [String] = []
  private var created = false
  private var read = false
  private var failures = 0
  private var profileContinuation: CheckedContinuation<Void, Never>?
  private var profileReleased = false
  private var completedProfiles = 0
  static let tenant = "local-padel"
  static let root = "/user/api/v1/local-padel"

  init(mode: Mode) throws {
    self.mode = mode
    let url = Bundle(for: DirectIntegrationFixture.self)
      .url(forResource: "direct-integration-fixtures", withExtension: "json")!
    data = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    peerID = data["peerId"] as! String
    directID = data["directId"] as! String
    viewerID = data["viewerId"] as! String
  }

  func configuration() throws -> SessionConfiguration {
    // Existing allowlisted origin is only an identity here; send is injected below.
    try SessionConfiguration(origin: "https://lk2.padlhub.su", tenant: Self.tenant,
      appVersion: "synthetic", appBuild: "1")
  }

  func transport() throws -> SessionTransport {
    SessionTransport(configuration: try configuration(), store: store) { [self] request in
      let reply = try respond(request)
      if mode == .delayedProfile && request.url?.path == Self.root + "/profiles/" + peerID {
        await waitForProfileRelease()
        profileCompleted()
      }
      return reply
    }
  }

  func snapshot() -> Snapshot {
    lock.lock(); defer { lock.unlock() }
    return Snapshot(requests: requests, createKeys: createKeys, unexpected: unexpected,
      completedProfiles: completedProfiles)
  }

  private func waitForProfileRelease() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      let released = profileReleased
      if !released { profileContinuation = continuation }
      lock.unlock()
      if released { continuation.resume() }
    }
  }

  func releaseProfile() {
    lock.lock()
    profileReleased = true
    let continuation = profileContinuation
    profileContinuation = nil
    lock.unlock()
    continuation?.resume()
  }

  private func profileCompleted() {
    lock.lock(); defer { lock.unlock() }; completedProfiles += 1
  }

  private func respond(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
    lock.lock(); defer { lock.unlock() }
    guard let url = request.url else { throw SessionFailure.request }
    let method = request.httpMethod ?? ""
    let path = url.path
    let signature = method + " " + path
    requests.append(signature)
    func reject() throws -> (Data, HTTPURLResponse) {
      unexpected.append(signature)
      throw SessionFailure.request
    }
    guard url.scheme == "https", url.host == "lk2.padlhub.su", url.port == nil,
      url.user == nil, url.password == nil, url.fragment == nil
    else { return try reject() }
    func body() -> [String: Any]? {
      guard let bytes = request.httpBody else { return nil }
      return (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
    }
    func response(_ value: Any, status: Int = 200, cookie: Bool = false) throws -> (Data, HTTPURLResponse) {
      var headers = ["Content-Type": "application/json"]
      if cookie {
        headers["Set-Cookie"] = "phub_refresh=" + String(repeating: "s", count: 48)
          + "; Max-Age=3600; Path=" + Self.root + "/auth; HttpOnly; Secure; SameSite=Lax"
      }
      return (status == 204 ? Data() : try JSONSerialization.data(withJSONObject: value),
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }
    if method == "POST", path == Self.root + "/auth/challenges" {
      guard url.query == nil, let value = body(), Set(value.keys) == ["method", "phone"],
        value["method"] as? String == "phone_otp", value["phone"] as? String == "+79990000000"
      else { return try reject() }
      return try response(["challengeId": viewerID, "expiresAt": "2099-01-01T00:00:00Z"])
    }
    if method == "POST", path == Self.root + "/auth/challenges/" + viewerID + "/verify" {
      guard url.query == nil, let value = body(), Set(value.keys) == ["code", "acceptance"],
        value["code"] as? String == "1234",
        let acceptance = value["acceptance"] as? [String: Bool],
        acceptance == ["publicOfferAccepted": true, "personalDataPolicyAccepted": true]
      else { return try reject() }
      return try response(data["auth"]!, cookie: true)
    }
    if method == "DELETE", path == Self.root + "/auth/session" {
      guard url.query == nil, request.value(forHTTPHeaderField: "Cookie")?.hasPrefix("phub_refresh=") == true
      else { return try reject() }
      return try response([:], status: 204)
    }
    if method == "POST", path == Self.root + "/auth/session/refresh" {
      guard url.query == nil, request.value(forHTTPHeaderField: "Cookie")?.hasPrefix("phub_refresh=") == true
      else { return try reject() }
      return try response(data["auth"]!, cookie: true)
    }
    let publicGames = method == "GET" && path == "/public/api/v1/local-padel/games"
    let authorization = request.value(forHTTPHeaderField: "Authorization")
    guard (publicGames ? authorization == nil : authorization == "Bearer synthetic-short-lived-access"),
      request.value(forHTTPHeaderField: "Cookie") == nil
    else { return try reject() }
    if method == "GET" {
      guard request.httpBody == nil else { return try reject() }
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      guard query.allSatisfy({ ["limit", "afterSequence", "stationId", "startsFrom", "startsTo", "kind", "levelFrom", "levelTo", "availability", "cursor"].contains($0.name) })
      else { return try reject() }
      let routes = ["/home/base": "homeBase", "/home": "home", "/profile": "profile",
        "/profile/booking-preferences": "preferences", "/profile/privacy": "privacy",
        "/bookings/upcoming": "bookings", "/bookings/history": "history",
        "/recommendations/bookings": "recommendations", "/communities/mine": "communities"]
      if let key = routes.first(where: { Self.root + $0.key == path })?.value {
        return try response(data[key]!)
      }
      if publicGames {
        guard query.count == 2, Set(query.map(\.name)) == ["limit", "availability"],
          query.first(where: { $0.name == "limit" })?.value == "20",
          query.first(where: { $0.name == "availability" })?.value == "INCLUDE_FULL"
        else { return try reject() }
        return try response(data["publicGames"]!)
      }
      if path == Self.root + "/profiles/" + peerID {
        guard query.isEmpty else { return try reject() }
        var profile = data["otherProfile"] as! [String: Any]
        if mode == .locked || mode == .wrongTarget {
          var access = profile["access"] as! [String: Any]
          access["chat"] = mode == .locked
            ? ["status": "LOCKED", "reason": "PRIVACY_POLICY"]
            : ["status": "AVAILABLE", "route": "/chats/new?recipientUserId=" + viewerID + "&open=1"]
          profile["access"] = access
        }
        return try response(profile)
      }
      if path == Self.root + "/conversations" {
        var conversation = data["conversation"] as! [String: Any]
        conversation["unreadCount"] = read ? 0 : 1
        return try response(["items": created ? [conversation] : []])
      }
      if path == Self.root + "/conversations/" + directID + "/messages" {
        let after = Int(query.first(where: { $0.name == "afterSequence" })?.value ?? "0") ?? 0
        return try response(after >= 1 ? ["messages": []] : data["messages"]!)
      }
      return try reject()
    }
    if method == "POST", path == Self.root + "/messaging/realtime-ticket" {
      guard request.httpBody == nil, url.query == nil else { return try reject() }
      return try response(["code": "REALTIME_MESSAGING_DISABLED"], status: 404)
    }
    if method == "POST", path == Self.root + "/conversations/direct" {
      guard url.query == nil, let value = body(), Set(value.keys) == ["otherUserId"],
        value["otherUserId"] as? String == peerID,
        let key = request.value(forHTTPHeaderField: "Idempotency-Key"), !key.isEmpty
      else { return try reject() }
      createKeys.append(key)
      if mode == .offline && failures == 0 { failures += 1; throw SessionFailure.network }
      created = true
      if mode == .lostResponse && failures == 0 { failures += 1; throw SessionFailure.network }
      return try response(["outcome": "ok", "conversation": data["conversation"]!, "created": true, "replayed": createKeys.count > 1])
    }
    if method == "PUT", path == Self.root + "/conversations/" + directID + "/read-cursor" {
      guard url.query == nil, let value = body(), Set(value.keys) == ["throughSequence"],
        value["throughSequence"] as? Int == 1,
        request.value(forHTTPHeaderField: "Idempotency-Key") != nil
      else { return try reject() }
      read = true
      return try response(["outcome": "ok", "readThroughSequence": 1, "changed": true, "replayed": false])
    }
    return try reject()
  }
}
#endif
