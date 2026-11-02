import Foundation

/// Fixed station-only transport. Identity, origin and method are never supplied by JavaScript.
public struct StationMessageRequest: Sendable {
  public let resource: String
  public let communityID: String
  public let requestID: String?
  public let query: [String:String]
  public init(resource: String, communityID: String, requestID: String? = nil, query: [String:String] = [:]) {
    self.resource=resource; self.communityID=communityID; self.requestID=requestID; self.query=query
  }
  private static let uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  private static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: "\\A(?:\(pattern))\\z",options:.regularExpression) != nil
  }
  func urlRequest(configuration: SessionConfiguration, headers: [String:String], body: String?) throws -> URLRequest {
    guard Self.matches(communityID,Self.uuid), ["send","status","history"].contains(resource) else {throw SessionFailure.request}
    let allowed = Set(["authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"])
    var normalized:[String:String]=[:]
    for (name,value) in headers {
      let name=name.lowercased()
      guard allowed.contains(name), normalized[name]==nil, value.utf8.count<=8192, !value.contains("\r"), !value.contains("\n") else {throw SessionFailure.request}
      normalized[name]=value
    }
    guard let bearer=normalized["authorization"], Self.matches(bearer,"Bearer [A-Za-z0-9._-]{8,8192}") else {throw SessionFailure.request}
    var suffix="/community-views/\(communityID)/"
    if resource == "send" {
      let string = #""(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*""#
      let envelope = #"\s*\{\s*"requestId"\s*:\s*"# + string + #"\s*,\s*"text"\s*:\s*"# + string + #"\s*\}\s*"#
      guard query.isEmpty, let requestID, Self.matches(requestID,Self.uuid), normalized["idempotency-key"] == requestID,
        normalized["content-type"] == "application/json", let body, body.utf8.count <= 65_536,
        Self.matches(body,envelope), let data=body.data(using:.utf8),
        let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
        object["requestId"] as? String == requestID, let text=object["text"] as? String,
        text.utf16.count <= 8000, !text.trimmingCharacters(in:.whitespacesAndNewlines.union(CharacterSet(charactersIn:"\u{FEFF}"))).isEmpty
      else {throw SessionFailure.request}
      suffix += "message-requests"
    } else {
      guard body == nil, normalized["idempotency-key"] == nil, normalized["content-type"] == nil || normalized["content-type"] == "application/json" else {throw SessionFailure.request}
      if resource == "status" {
        guard query.isEmpty, let requestID, Self.matches(requestID,Self.uuid) else {throw SessionFailure.request}
        suffix += "message-requests/\(requestID)"
      } else {
        guard requestID == nil, Set(query.keys).isSubset(of:["limit","cursor"]) else {throw SessionFailure.request}
        for (key,value) in query {
          guard Self.matches(value,key == "limit" ? "[1-9]|[1-4][0-9]|50" : "[A-Za-z0-9_-]{16,512}") else {throw SessionFailure.request}
        }
        suffix += "chat"
      }
    }
    guard var url=URLComponents(string:configuration.origin + "/user/api/v1/\(configuration.tenant)" + suffix) else {throw SessionFailure.request}
    if !query.isEmpty {url.queryItems=query.keys.sorted().map {URLQueryItem(name:$0,value:query[$0])}}
    guard let destination=url.url else {throw SessionFailure.request}
    var request=URLRequest(url:destination,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:15)
    request.httpMethod=resource == "send" ? "POST":"GET"; request.httpShouldHandleCookies=false
    request.setValue(bearer,forHTTPHeaderField:"Authorization")
    request.setValue("application/json",forHTTPHeaderField:"Accept")
    request.setValue(normalized["x-correlation-id"] ?? UUID().uuidString,forHTTPHeaderField:"X-Correlation-ID")
    request.setValue("ios",forHTTPHeaderField:"X-App-Platform")
    request.setValue(configuration.appVersion,forHTTPHeaderField:"X-App-Version")
    request.setValue(configuration.appBuild,forHTTPHeaderField:"X-App-Build")
    if let body {request.httpBody=Data(body.utf8);request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.setValue(requestID,forHTTPHeaderField:"Idempotency-Key")}
    return request
  }
}
