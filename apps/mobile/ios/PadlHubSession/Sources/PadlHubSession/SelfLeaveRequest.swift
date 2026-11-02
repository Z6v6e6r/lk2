import Foundation

/// Three original-key self-leave routes; no caller-selected URL, body or member.
public struct SelfLeaveRequest: Sendable {
  public let gameID: String
  public let resource: String
  public init(resource:String,gameID: String) { self.resource=resource;self.gameID = gameID }
  private static func matches(_ value: String, _ pattern: String) -> Bool {
    guard let r = value.range(of: pattern, options: .regularExpression) else { return false }
    return r == value.startIndex..<value.endIndex
  }
  func urlRequest(configuration: SessionConfiguration, headers: [String:String], body: String?) throws -> URLRequest {
    guard Self.matches(gameID, "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"),
      body == nil, ["leave","status","reconcile"].contains(resource)
    else { throw SessionFailure.request }
    let allowed = Set(["authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"])
    var normalized: [String:String] = [:]
    for (name, value) in headers {
      let name = name.lowercased()
      guard allowed.contains(name), normalized[name] == nil, value.utf8.count <= 8192,
        !value.contains("\r"), !value.contains("\n") else {throw SessionFailure.request}
      normalized[name] = value
    }
    guard let bearer = normalized["authorization"], Self.matches(bearer,"Bearer [A-Za-z0-9._-]{8,8192}"),
      let key = normalized["idempotency-key"], Self.matches(key,"[A-Za-z0-9][A-Za-z0-9._:-]{15,127}"),
      normalized["content-type"] == nil || normalized["content-type"] == "text/plain",
      let url = URL(string:configuration.origin + "/user/api/v1/\(configuration.tenant)/games/\(gameID)/" + (resource == "leave" ? "participants/me" : resource == "status" ? "leave-operation" : "leave-operation/reconcile"))
    else {throw SessionFailure.request}
    var request = URLRequest(url:url,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:20)
    request.httpMethod = resource == "leave" ? "DELETE" : resource == "status" ? "GET" : "POST"; request.httpShouldHandleCookies = false
    request.setValue(bearer,forHTTPHeaderField:"Authorization")
    request.setValue(key,forHTTPHeaderField:"Idempotency-Key")
    request.setValue("application/json",forHTTPHeaderField:"Accept")
    if resource != "status" {request.setValue("text/plain",forHTTPHeaderField:"Content-Type")}
    request.setValue(normalized["x-correlation-id"] ?? UUID().uuidString,forHTTPHeaderField:"X-Correlation-ID")
    request.setValue("ios",forHTTPHeaderField:"X-App-Platform")
    request.setValue(configuration.appVersion,forHTTPHeaderField:"X-App-Version")
    request.setValue(configuration.appBuild,forHTTPHeaderField:"X-App-Build")
    return request
  }
}
