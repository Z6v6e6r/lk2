import Foundation

/// V3 station reads and explicit read receipt commands. Builds only configured PadlHub URLs.
public struct StationStreamRequest: Sendable {
  public let resource: String
  public let communityID: String?
  public let requestID: String?
  public let query: [String:String]
  public init(resource: String, communityID: String? = nil, requestID: String? = nil, query: [String:String] = [:]) {
    self.resource=resource; self.communityID=communityID; self.requestID=requestID; self.query=query
  }
  private static let uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  private static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: "\\A(?:\(pattern))\\z",options:.regularExpression) != nil
  }
  func urlRequest(configuration: SessionConfiguration, headers: [String:String], body: String?) throws -> URLRequest {
    guard ["summaries","stream","read","readStatus"].contains(resource) else {throw SessionFailure.request}
    var normalized:[String:String]=[:]
    let allowed=Set(["authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"])
    for (name,value) in headers {
      let name=name.lowercased()
      guard allowed.contains(name), normalized[name]==nil, value.utf8.count<=8192, !value.contains("\r"), !value.contains("\n") else {throw SessionFailure.request}
      normalized[name]=value
    }
    guard let bearer=normalized["authorization"], Self.matches(bearer,"Bearer [A-Za-z0-9._-]{8,8192}") else {throw SessionFailure.request}
    var path="/community-views/"
    if resource == "summaries" {
      guard communityID == nil, requestID == nil, Set(query.keys)==["communityIds"], let ids=query["communityIds"], ids.utf8.count<=1849,
        Self.matches(ids,Self.uuid + "(?:," + Self.uuid + "){0,49}") else {throw SessionFailure.request}
      let parts=ids.split(separator:",")
      guard Set(parts).count==parts.count else {throw SessionFailure.request}
      path += "station-stream-summaries"
    } else {
      guard let communityID, Self.matches(communityID,Self.uuid) else {throw SessionFailure.request}
      path += communityID + "/"
      if resource == "stream" {
        guard requestID == nil, Set(query.keys).isSubset(of:["limit","cursor"]) else {throw SessionFailure.request}
        for (key,value) in query {
          guard Self.matches(value,key == "limit" ? "[1-9]|[1-4][0-9]|50" : "[A-Za-z0-9_-]{16,1024}") else {throw SessionFailure.request}
        }
        path += "station-stream"
      } else {
        guard query.isEmpty, let requestID, Self.matches(requestID,Self.uuid) else {throw SessionFailure.request}
        path += "read-requests" + (resource == "readStatus" ? "/" + requestID : "")
      }
    }
    if resource == "read" {
      let envelope="\\s*\\{\\s*\"requestId\"\\s*:\\s*\"" + Self.uuid + "\"\\s*,\\s*\"streamId\"\\s*:\\s*\"" + Self.uuid + "\"\\s*,\\s*\"membershipEpoch\"\\s*:\\s*(?:0|[1-9][0-9]*)\\s*,\\s*\"throughSequence\"\\s*:\\s*(?:0|[1-9][0-9]*)\\s*\\}\\s*"
      guard let body, body.utf8.count<=16384, Self.matches(body,envelope), normalized["content-type"]=="application/json", normalized["idempotency-key"]==requestID,
        let data=body.data(using:.utf8), let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any], object["requestId"] as? String == requestID
      else {throw SessionFailure.request}
      for field in ["membershipEpoch","throughSequence"] {
        guard let value=object[field] as? NSNumber, value.doubleValue>=0, value.doubleValue<=9007199254740990, value.doubleValue.rounded()==value.doubleValue else {throw SessionFailure.request}
      }
    } else {
      guard body == nil, normalized["idempotency-key"] == nil, normalized["content-type"] == nil || normalized["content-type"]=="application/json" else {throw SessionFailure.request}
    }
    guard var url=URLComponents(string:configuration.origin + "/user/api/v1/\(configuration.tenant)" + path) else {throw SessionFailure.request}
    if !query.isEmpty {url.queryItems=query.keys.sorted().map {URLQueryItem(name:$0,value:query[$0])}}
    guard let destination=url.url else {throw SessionFailure.request}
    var request=URLRequest(url:destination,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:15)
    request.httpMethod=resource == "read" ? "POST":"GET"; request.httpShouldHandleCookies=false
    request.setValue(bearer,forHTTPHeaderField:"Authorization"); request.setValue("application/json",forHTTPHeaderField:"Accept")
    request.setValue(normalized["x-correlation-id"] ?? UUID().uuidString,forHTTPHeaderField:"X-Correlation-ID")
    request.setValue("ios",forHTTPHeaderField:"X-App-Platform"); request.setValue(configuration.appVersion,forHTTPHeaderField:"X-App-Version"); request.setValue(configuration.appBuild,forHTTPHeaderField:"X-App-Build")
    if let body {request.httpBody=Data(body.utf8);request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.setValue(requestID,forHTTPHeaderField:"Idempotency-Key")}
    return request
  }
}
