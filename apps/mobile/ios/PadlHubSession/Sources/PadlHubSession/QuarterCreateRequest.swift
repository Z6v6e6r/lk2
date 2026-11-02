import Foundation

/// Five authenticated quarter CREATE resources. No caller URL, tenant, method or price.
public struct QuarterCreateRequest: Sendable {
  public let resource: String
  public let operationID: String?
  public init(resource: String, operationID: String? = nil) {
    self.resource = resource; self.operationID = operationID
  }
  private static func matches(_ value: String, _ pattern: String) -> Bool {
    guard let range = value.range(of: pattern, options: .regularExpression) else { return false }
    return range == value.startIndex..<value.endIndex
  }
  private static let uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  func urlRequest(configuration: SessionConfiguration, headers: [String:String], body: String?) throws -> URLRequest {
    let suffix: String, method: String, keyed: Bool
    switch resource {
    case "capability", "locations": suffix = "/" + resource; method = "GET"; keyed = false
    case "byKey": suffix = "/by-key"; method = "GET"; keyed = true
    case "create": suffix = ""; method = "POST"; keyed = true
    case "reconcile":
      guard let id = operationID, Self.matches(id, Self.uuid) else { throw SessionFailure.request }
      suffix = "/\(id)/reconcile"; method = "POST"; keyed = true
    default: throw SessionFailure.request
    }
    guard resource == "reconcile" || operationID == nil else { throw SessionFailure.request }
    let allowed = Set(["authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"])
    var normalized: [String:String] = [:]
    for (name, value) in headers {
      let name = name.lowercased()
      guard allowed.contains(name), normalized[name] == nil, value.utf8.count <= 8192,
        !value.contains("\r"), !value.contains("\n") else { throw SessionFailure.request }
      normalized[name] = value
    }
    guard let bearer = normalized["authorization"], Self.matches(bearer,"Bearer [A-Za-z0-9._-]{8,8192}") else { throw SessionFailure.request }
    if keyed {
      guard let key = normalized["idempotency-key"], Self.matches(key,"[A-Za-z0-9._:-]{16,128}") else { throw SessionFailure.request }
    } else if normalized["idempotency-key"] != nil { throw SessionFailure.request }
    if method == "GET" { guard body == nil else { throw SessionFailure.request } }
    else {
      guard let body, let data = body.data(using:.utf8), data.count <= 1024 else { throw SessionFailure.request }
      let property = #""(?:stationId|courtId|startsAt|subscriptionId)"\s*:\s*"[^"\\\u0000-\u001f]*""#
      guard Self.matches(body, "\\s*\\{\\s*" + property + "(?:\\s*,\\s*" + property + "){3}\\s*\\}\\s*"),
        let x = try? JSONSerialization.jsonObject(with:data) as? [String:String],
        Set(x.keys) == Set(["stationId","courtId","startsAt","subscriptionId"]),
        ["stationId","courtId","subscriptionId"].allSatisfy({ Self.matches(x[$0] ?? "",Self.uuid) }),
        let date = x["startsAt"], Self.matches(date,#"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\.000Z"#), !date.hasPrefix("0000")
      else { throw SessionFailure.request }
      let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
      guard let parsed = parser.date(from:date), parser.string(from:parsed) == date,
        normalized["content-type"] == nil || normalized["content-type"]?.lowercased() == "application/json" else { throw SessionFailure.request }
    }
    guard let url = URL(string:configuration.origin + "/user/api/v1/\(configuration.tenant)/game-create-operations" + suffix) else { throw SessionFailure.request }
    var request = URLRequest(url:url,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:20)
    request.httpMethod = method; request.httpShouldHandleCookies = false
    request.setValue(bearer,forHTTPHeaderField:"Authorization")
    if keyed {request.setValue(normalized["idempotency-key"],forHTTPHeaderField:"Idempotency-Key")}
    request.setValue("application/json",forHTTPHeaderField:"Accept")
    request.setValue(normalized["x-correlation-id"] ?? UUID().uuidString,forHTTPHeaderField:"X-Correlation-ID")
    request.setValue("ios",forHTTPHeaderField:"X-App-Platform")
    request.setValue(configuration.appVersion,forHTTPHeaderField:"X-App-Version")
    request.setValue(configuration.appBuild,forHTTPHeaderField:"X-App-Build")
    if let body {request.httpBody = Data(body.utf8);request.setValue("application/json",forHTTPHeaderField:"Content-Type")}
    return request
  }
}
