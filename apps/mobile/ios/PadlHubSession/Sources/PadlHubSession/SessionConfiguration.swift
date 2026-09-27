import Foundation

public enum SessionFailure: String, Error {
  case configuration = "NATIVE_CONFIGURATION_REQUIRED"
  case request = "NATIVE_REQUEST_REJECTED"
  case response = "NATIVE_RESPONSE_REJECTED"
  case redirect = "NATIVE_REDIRECT_REJECTED"
  case storage = "NATIVE_STORAGE_UNAVAILABLE"
  case network = "NATIVE_NETWORK_UNAVAILABLE"
}

public struct SessionConfiguration: Sendable {
  public let origin: String
  public let tenant: String
  public let appVersion: String
  public let appBuild: String
  public var authPath: String { "/user/api/v1/\(tenant)/auth" }
  public var keychainScope: String { "\(origin)|\(tenant)" }

  public init(origin: String, tenant: String, appVersion: String, appBuild: String) throws {
    // Reviewed first-party origins. There is deliberately no default server.
    var origins = ["https://lk2.padlhub.su"]
    #if DEBUG
      origins.append("https://lk.nano.padlhub.su")
    #endif
    guard origins.contains(origin),
      tenant.range(of: "^[a-z0-9][a-z0-9-]{1,62}$", options: .regularExpression) != nil
    else { throw SessionFailure.configuration }
    self.origin = origin
    self.tenant = tenant
    self.appVersion = appVersion
    self.appBuild = appBuild
  }
}

public enum SessionOperation: String, Sendable {
  case challenge, verify, refresh, logout, context
}

public struct SessionRequest: Sendable {
  public let operation: SessionOperation
  public let challengeID: String?
  public let headers: [String: String]
  public let body: String?

  public init(
    operation: SessionOperation, challengeID: String? = nil,
    headers: [String: String] = [:], body: String? = nil
  ) {
    self.operation = operation
    self.challengeID = challengeID
    self.headers = headers
    self.body = body
  }

  func urlRequest(configuration: SessionConfiguration) throws -> URLRequest {
    var path = configuration.authPath
    let method: String
    switch operation {
    case .challenge:
      path += "/challenges"
      method = "POST"
    case .verify:
      guard let id = challengeID, UUID(uuidString: id) != nil else { throw SessionFailure.request }
      path += "/challenges/\(id)/verify"
      method = "POST"
    case .refresh:
      path += "/session/refresh"
      method = "POST"
    case .logout:
      path += "/session"
      method = "DELETE"
    case .context:
      path = "/user/api/v1/\(configuration.tenant)/context"
      method = "GET"
    }
    guard challengeID == nil || operation == .verify,
      let url = URL(string: configuration.origin + path)
    else { throw SessionFailure.request }
    var request = URLRequest(
      url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
    request.httpMethod = method
    request.httpShouldHandleCookies = false
    let allowed = Set([
      "accept", "content-type", "idempotency-key", "x-correlation-id",
      "x-app-platform", "x-app-version", "x-app-build", "x-session-intent", "authorization",
    ])
    var normalized: [String: String] = [:]
    for (name, value) in headers {
      let name = name.lowercased()
      guard allowed.contains(name), normalized[name] == nil, value.utf8.count <= 8192,
        !value.contains("\r"), !value.contains("\n")
      else { throw SessionFailure.request }
      normalized[name] = value
    }
    if operation == .context {
      guard let authorization = normalized["authorization"], authorization.hasPrefix("Bearer "),
        authorization.count > 7
      else { throw SessionFailure.request }
      request.setValue(authorization, forHTTPHeaderField: "Authorization")
    } else {
      guard normalized["authorization"] == nil,
        let key = normalized["idempotency-key"],
        key.range(of: "^[A-Za-z0-9._:-]{16,128}$", options: .regularExpression) != nil
      else { throw SessionFailure.request }
      request.setValue(key, forHTTPHeaderField: "Idempotency-Key")
    }
    let intent = operation == .refresh ? "refresh" : operation == .logout ? "logout" : nil
    guard normalized["x-session-intent"] == intent else { throw SessionFailure.request }
    if let intent { request.setValue(intent, forHTTPHeaderField: "X-Session-Intent") }
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(
      normalized["x-correlation-id"] ?? UUID().uuidString,
      forHTTPHeaderField: "X-Correlation-ID")
    request.setValue("ios", forHTTPHeaderField: "X-App-Platform")
    request.setValue(configuration.appVersion, forHTTPHeaderField: "X-App-Version")
    request.setValue(configuration.appBuild, forHTTPHeaderField: "X-App-Build")
    if operation == .challenge || operation == .verify {
      guard let body, let data = body.data(using: .utf8), data.count <= 4096,
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { throw SessionFailure.request }
      if operation == .challenge {
        guard Set(object.keys) == ["method", "phone"], object["method"] as? String == "phone_otp",
          let phone = object["phone"] as? String,
          phone.range(of: "^\\+7[0-9]{10}$", options: .regularExpression) != nil
        else { throw SessionFailure.request }
      } else {
        guard Set(object.keys) == ["code", "acceptance"], let code = object["code"] as? String,
          code.range(of: "^[0-9]{4}$", options: .regularExpression) != nil,
          let acceptance = object["acceptance"] as? [String: Any],
          Set(acceptance.keys) == ["publicOfferAccepted", "personalDataPolicyAccepted"],
          acceptance["publicOfferAccepted"] as? Bool == true,
          acceptance["personalDataPolicyAccepted"] as? Bool == true
        else { throw SessionFailure.request }
      }
      request.httpBody = data
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    } else if body != nil {
      throw SessionFailure.request
    }
    return request
  }
}

public struct SessionResponse: Sendable {
  public let status: Int
  public let headers: [String: String]
  public let body: String

  static let signedOut = SessionResponse(
    status: 401, headers: ["Content-Type": "application/json"],
    body: "{\"code\":\"AUTH_SESSION_REVOKED\",\"message\":\"Session unavailable\"}")
  static let loggedOut = SessionResponse(status: 204, headers: [:], body: "")
}
