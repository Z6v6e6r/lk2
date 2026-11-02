import Foundation

/// Concrete LOCAL_ONLY tournament wire. No URL, tenant, arbitrary method or provider selector.
public struct TournamentRequest: Sendable {
  public let resource: String
  public let id: String?
  public let operationID: String?
  public let query: [String: String]
  public init(resource: String, id: String? = nil, operationID: String? = nil, query: [String: String] = [:]) {
    self.resource = resource; self.id = id; self.operationID = operationID; self.query = query
  }

  private let uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
  private func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: "\\A(?:" + pattern + ")\\z", options: .regularExpression) != nil
  }
  private func validID(_ value: String?) -> Bool { value.map { matches($0, uuid) } ?? false }
  private func day(_ value: String?) throws -> Date {
    guard let value, matches(value, "[0-9]{4}-[0-9]{2}-[0-9]{2}"), !value.hasPrefix("0000") else { throw SessionFailure.request }
    let parser = DateFormatter()
    parser.locale = Locale(identifier: "en_US_POSIX")
    parser.calendar = Calendar(identifier: .gregorian)
    parser.timeZone = TimeZone(secondsFromGMT: 0)
    parser.dateFormat = "yyyy-MM-dd"; parser.isLenient = false
    guard let date = parser.date(from: value), parser.string(from: date) == value else { throw SessionFailure.request }
    return date
  }

  func urlRequest(configuration: SessionConfiguration, headers: [String: String], body: String?) throws -> URLRequest {
    let isPublic = resource == "list" || resource == "summary"
    let suffix: String
    let method: String
    if isPublic {
      guard operationID == nil, body == nil,
        resource == "list" ? id == nil : validID(id),
        Set(query.keys).isSubset(of: resource == "list" ? ["dateFrom", "dateTo", "availability", "limit"] : ["dateFrom", "dateTo"])
      else { throw SessionFailure.request }
      let interval = try day(query["dateTo"]).timeIntervalSince(day(query["dateFrom"]))
      guard interval > 0, interval <= 15 * 86400 else { throw SessionFailure.request }
      if let value = query["availability"], !["JOINABLE", "INCLUDE_FULL"].contains(value) { throw SessionFailure.request }
      if let value = query["limit"], !matches(value, "[1-9]|[1-4][0-9]|50") { throw SessionFailure.request }
      suffix = resource == "list" ? "" : "/" + id!; method = "GET"
    } else {
      guard validID(id), query.isEmpty else { throw SessionFailure.request }
      switch resource {
      case "participants":
        guard operationID == nil, body == nil else { throw SessionFailure.request }
        suffix = "/\(id!)/participants"; method = "GET"
      case "status":
        guard operationID == nil || validID(operationID), body == nil else { throw SessionFailure.request }
        suffix = "/\(id!)/registration-operation"; method = "GET"
      case "command":
        guard operationID == nil, let body, body.utf8.count <= 256 else { throw SessionFailure.request }
        let action = "\"action\"\\s*:\\s*\"LEAVE\""
        let original = "\"originalJoinOperationId\"\\s*:\\s*\"" + uuid + "\""
        guard matches(body, "\\s*\\{\\s*(?:\"action\"\\s*:\\s*\"JOIN\"|" + action + "\\s*,\\s*" + original + "|" + original + "\\s*,\\s*" + action + ")\\s*\\}\\s*") else { throw SessionFailure.request }
        suffix = "/\(id!)/registrations"; method = "POST"
      case "retry":
        guard validID(operationID), body == nil else { throw SessionFailure.request }
        suffix = "/\(id!)/registration-operations/\(operationID!)/retry"; method = "POST"
      default: throw SessionFailure.request
      }
    }
    let allowed: Set<String> = ["accept", "content-type", "authorization", "idempotency-key", "x-correlation-id", "x-app-platform", "x-app-version", "x-app-build"]
    var normalized: [String: String] = [:]
    for (name, value) in headers {
      let key = name.lowercased()
      guard allowed.contains(key), normalized[key] == nil, value.utf8.count <= 8192,
        !value.contains("\r"), !value.contains("\n") else { throw SessionFailure.request }
      normalized[key] = value
    }
    if isPublic {
      guard normalized["authorization"] == nil, normalized["idempotency-key"] == nil else { throw SessionFailure.request }
    } else {
      guard let bearer = normalized["authorization"], matches(bearer, "Bearer [A-Za-z0-9._-]{8,8192}") else { throw SessionFailure.request }
      if resource == "participants", normalized["idempotency-key"] != nil { throw SessionFailure.request }
      if method == "POST", normalized["idempotency-key"] == nil { throw SessionFailure.request }
      if let key = normalized["idempotency-key"], !matches(key, "[A-Za-z0-9][A-Za-z0-9._:-]{15,127}") { throw SessionFailure.request }
    }
    var url = URLComponents(string: configuration.origin)!
    url.path = "/\(isPublic ? "public" : "user")/api/v1/\(configuration.tenant)/tournaments" + suffix
    if isPublic { url.queryItems = query.keys.sorted().map { URLQueryItem(name: $0, value: query[$0]) } }
    else if resource == "status", let operationID { url.queryItems = [URLQueryItem(name: "operationId", value: operationID)] }
    guard let destination = url.url else { throw SessionFailure.request }
    var request = URLRequest(url: destination, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
    request.httpMethod = method; request.httpShouldHandleCookies = false
    for name in ["authorization", "idempotency-key"] { request.setValue(normalized[name], forHTTPHeaderField: name) }
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(normalized["x-correlation-id"] ?? UUID().uuidString, forHTTPHeaderField: "X-Correlation-ID")
    request.setValue("ios", forHTTPHeaderField: "X-App-Platform")
    request.setValue(configuration.appVersion, forHTTPHeaderField: "X-App-Version")
    request.setValue(configuration.appBuild, forHTTPHeaderField: "X-App-Build")
    if let body { request.httpBody = Data(body.utf8); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    return request
  }
}
