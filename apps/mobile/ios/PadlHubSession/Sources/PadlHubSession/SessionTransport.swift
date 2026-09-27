import Foundation

final class RejectRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

public actor SessionTransport {
  private let configuration: SessionConfiguration
  private let store: CredentialStore
  private let send: (URLRequest) async throws -> (Data, HTTPURLResponse)
  private var tail: Task<Void, Never>?

  public init(configuration: SessionConfiguration, bundleID: String) throws {
    let settings = Self.urlSessionConfiguration()
    let session = URLSession(
      configuration: settings, delegate: RejectRedirects(), delegateQueue: nil)
    self.configuration = configuration
    self.store = try KeychainCredentialStore(bundleID: bundleID, scope: configuration.keychainScope)
    self.send = { request in
      do {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw SessionFailure.response }
        return (data, response)
      } catch let error as SessionFailure { throw error } catch { throw SessionFailure.network }
    }
  }

  init(
    configuration: SessionConfiguration, store: CredentialStore,
    send: @escaping (URLRequest) async throws -> (Data, HTTPURLResponse)
  ) {
    self.configuration = configuration
    self.store = store
    self.send = send
  }

  static func urlSessionConfiguration() -> URLSessionConfiguration {
    let settings = URLSessionConfiguration.ephemeral
    settings.httpCookieStorage = nil
    settings.httpShouldSetCookies = false
    settings.urlCredentialStorage = nil
    settings.urlCache = nil
    settings.requestCachePolicy = .reloadIgnoringLocalCacheData
    settings.timeoutIntervalForRequest = 20
    settings.timeoutIntervalForResource = 30
    return settings
  }

  public func request(_ input: SessionRequest) async throws -> SessionResponse {
    // Journal logout before waiting behind an in-flight read/rotation. A process death
    // during that wait must still finish revocation on the next launch.
    if input.operation == .logout {
      let request = try input.urlRequest(configuration: configuration)
      // A refresh sent before expiry can still return a valid successor. Preserve
      // intent on that predecessor even if its local expiry passed while waiting.
      if var credential = try store.read(), credential.scope == configuration.keychainScope {
        credential.logoutKey = credential.logoutKey ?? request.value(forHTTPHeaderField: "Idempotency-Key")
        try store.write(credential)
      }
    }
    // An actor alone is reentrant at await. Explicit FIFO also prevents an older
    // verify/refresh response from recreating the credential after logout.
    let previous = tail
    let operation = Task {
      await previous?.value
      return try await self.perform(input)
    }
    tail = Task { _ = await operation.result }
    return try await operation.value
  }

  private func perform(_ input: SessionRequest) async throws -> SessionResponse {
    let request = try input.urlRequest(configuration: configuration)
    switch input.operation {
    case .refresh:
      guard let credential = try currentCredential() else { return .signedOut }
      if credential.logoutKey != nil {
        let result = try await logout(credential, request: request)
        return result.status == 204 ? .signedOut : result
      }
      return try await refresh(credential, request: request)
    case .logout:
      guard var credential = try currentCredential() else { return .loggedOut }
      credential.logoutKey =
        credential.logoutKey ?? request.value(forHTTPHeaderField: "Idempotency-Key")
      try store.write(credential)
      return try await logout(credential, request: request)
    case .verify:
      guard try currentCredential() == nil else { throw SessionFailure.request }
      let (data, response) = try await checkedSend(request)
      if response.statusCode == 200 {
        try validateSessionBody(data)
        try acceptCookie(response, previous: nil)
      }
      return try bridgeResponse(data, response)
    case .context, .read:
      guard let credential = try currentCredential(), credential.logoutKey == nil else {
        return .signedOut
      }
      fallthrough
    case .challenge:
      let (data, response) = try await checkedSend(request)
      return try bridgeResponse(data, response)
    }
  }

  private func currentCredential() throws -> RefreshCredential? {
    guard let credential = try store.read() else { return nil }
    guard credential.expiresAt > Date(), credential.scope == configuration.keychainScope else {
      try store.clear()
      return nil
    }
    return credential
  }

  private func refresh(_ saved: RefreshCredential, request original: URLRequest) async throws
    -> SessionResponse
  {
    var credential = saved
    credential.refreshKey =
      credential.refreshKey ?? original.value(forHTTPHeaderField: "Idempotency-Key")
    // Journal the idempotency key before rotating. A lost response or process death
    // must retry the SAME predecessor/key pair, even on the next app launch.
    try store.write(credential)
    var request = URLRequest(
      url: URL(string: configuration.origin + configuration.authPath + "/session/refresh")!)
    request.httpMethod = "POST"
    request.allHTTPHeaderFields = original.allHTTPHeaderFields
    request.setValue(nil, forHTTPHeaderField: "Authorization")
    request.setValue("refresh", forHTTPHeaderField: "X-Session-Intent")
    request.setValue(credential.refreshKey, forHTTPHeaderField: "Idempotency-Key")
    request.setValue("phub_refresh=\(credential.value)", forHTTPHeaderField: "Cookie")
    request.httpShouldHandleCookies = false
    let (data, response) = try await checkedSend(request)
    if response.statusCode == 200 {
      try validateSessionBody(data)
      try acceptCookie(response, previous: credential)
    } else if response.statusCode == 401 {
      try store.clear()
    }
    return try bridgeResponse(data, response)
  }

  private func logout(_ saved: RefreshCredential, request original: URLRequest) async throws
    -> SessionResponse
  {
    var credential = saved
    // A previous refresh may have committed on the server before its response was
    // lost. Recover that successor first so logout revokes the current credential.
    if credential.refreshKey != nil {
      let recovered = try await refresh(credential, request: original)
      if recovered.status == 401 { return .loggedOut }
      guard recovered.status == 200, let current = try currentCredential() else { return recovered }
      credential = current
    }
    var request = URLRequest(
      url: URL(string: configuration.origin + configuration.authPath + "/session")!)
    request.httpMethod = "DELETE"
    request.allHTTPHeaderFields = original.allHTTPHeaderFields
    request.setValue(nil, forHTTPHeaderField: "Authorization")
    request.setValue("logout", forHTTPHeaderField: "X-Session-Intent")
    request.setValue(credential.logoutKey, forHTTPHeaderField: "Idempotency-Key")
    request.setValue("phub_refresh=\(credential.value)", forHTTPHeaderField: "Cookie")
    request.httpShouldHandleCookies = false
    let (data, response) = try await checkedSend(request)
    if response.statusCode == 204 { try store.clear() }
    return try bridgeResponse(data, response)
  }

  private func acceptCookie(_ response: HTTPURLResponse, previous: RefreshCredential?) throws {
    guard let url = response.url, let raw = response.value(forHTTPHeaderField: "Set-Cookie") else {
      try store.clear()
      throw SessionFailure.response
    }
    let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": raw], for: url)
      .filter { $0.name == "phub_refresh" }
    guard cookies.count == 1, let cookie = cookies.first, cookie.isSecure, cookie.isHTTPOnly,
      cookie.domain == url.host, cookie.path == configuration.authPath,
      cookie.value.range(of: "^[A-Za-z0-9_-]{32,512}$", options: .regularExpression) != nil,
      let expiry = cookie.expiresDate, expiry > Date(),
      raw.range(of: ";\\s*SameSite=Lax(?:;|$)", options: [.regularExpression, .caseInsensitive])
        != nil
    else {
      try store.clear()
      throw SessionFailure.response
    }
    let pendingLogout = try store.read()?.logoutKey
    try store.write(
      RefreshCredential(
        version: 1, scope: configuration.keychainScope,
        value: cookie.value, expiresAt: expiry, refreshKey: nil,
        logoutKey: previous?.logoutKey ?? pendingLogout))
  }

  private func validateSessionBody(_ data: Data) throws {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let token = object["accessToken"] as? String, !token.isEmpty,
      object["tokenType"] as? String == "Bearer", object["expiresAt"] is String,
      object["user"] is [String: Any], object["context"] is [String: Any],
      Set(object.keys).isSubset(of: ["accessToken", "tokenType", "expiresAt", "user", "context"])
    else {
      try store.clear()
      throw SessionFailure.response
    }
  }

  private func checkedSend(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await send(request)
    guard response.url == request.url, data.count <= 1_048_576 else {
      throw SessionFailure.response
    }
    guard !(300..<400).contains(response.statusCode) else { throw SessionFailure.redirect }
    return (data, response)
  }

  private func bridgeResponse(_ data: Data, _ response: HTTPURLResponse) throws -> SessionResponse {
    guard let body = String(data: data, encoding: .utf8) else { throw SessionFailure.response }
    var headers: [String: String] = [:]
    for name in ["Content-Type", "X-Correlation-ID", "Retry-After"] {
      if let value = response.value(forHTTPHeaderField: name) { headers[name] = value }
    }
    // Never bridge Set-Cookie, Cookie, or raw native errors to the WebView.
    return SessionResponse(status: response.statusCode, headers: headers, body: body)
  }
}
