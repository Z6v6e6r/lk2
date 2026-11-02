import Foundation

/// Closed monthly purchase contract. No caller URL or provider identity.
public struct MonthlyPurchaseRequest: Sendable {
  public let resource: String
  public let operationID: String?
  public init(resource: String, operationID: String? = nil) {
    self.resource = resource; self.operationID = operationID
  }
  private static func matches(_ value: String, _ pattern: String) -> Bool {
    guard let range = value.range(of: pattern, options: .regularExpression) else { return false }
    return range == value.startIndex..<value.endIndex
  }
  public static func launchURL(configuration:SessionConfiguration,operationID:String,launchCode:String)throws->URL {
    guard matches(operationID,uuid), matches(launchCode,uuid + #"\.[0-9a-f]{64}"#),
      let url=URL(string:configuration.origin+"/user/api/v1/subscription-payment-launch#operationId="+operationID+"&launchCode="+launchCode) else {throw SessionFailure.request}
    return url
  }
  private static let uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  func urlRequest(configuration: SessionConfiguration, headers: [String:String], body: String?) throws -> URLRequest {
    let suffix: String, method: String, keyed: Bool
    switch resource {
    case "capability": suffix = "/" + resource; method = "GET"; keyed = false
    case "byKey": suffix = "/by-key"; method = "GET"; keyed = true
    case "purchase": suffix = ""; method = "POST"; keyed = true
    case "quote": suffix = "/quote"; method = "POST"; keyed = true
    case "reconcile", "launch":
      guard let id = operationID, Self.matches(id, Self.uuid) else { throw SessionFailure.request }
      suffix = "/\(id)/" + (resource == "launch" ? "payment-launch" : "reconcile"); method = "POST"; keyed = true
    default: throw SessionFailure.request
    }
    guard resource == "reconcile" || resource == "launch" || operationID == nil else { throw SessionFailure.request }
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
      let count = resource == "quote" ? 1 : resource == "purchase" ? 4 : 0
      let field = #""(?:offerId|expectedRevision|amountMinor|currency)"\s*:\s*(?:"[A-Za-z0-9:-]+"|[0-9]+)"#
      let pattern = count == 0 ? #"\s*\{\s*\}\s*"# : #"\s*\{\s*"# + field + #"(?:\s*,\s*"# + field + "){" + String(count-1) + #"}\s*\}\s*"#
      guard Self.matches(body,pattern), let x = try? JSONSerialization.jsonObject(with:data) as? [String:Any],
        Set(x.keys) == (count == 1 ? Set(["offerId"]) : count == 4 ? Set(["offerId","expectedRevision","amountMinor","currency"]) : Set<String>()),
        normalized["content-type"] == nil || normalized["content-type"]?.lowercased() == "application/json"
      else {throw SessionFailure.request}
      if count > 0 {guard x["offerId"] as? String == "862670f6-a476-4a18-aecb-9e27661fbad3" else {throw SessionFailure.request}}
      if count == 4 {
        guard x["currency"] as? String == "RUB", let revision=x["expectedRevision"] as? String, Self.matches(revision,"sha256:[0-9a-f]{64}"),
          let amount=x["amountMinor"] as? NSNumber, amount.doubleValue>=1,amount.doubleValue<=100000000,amount.doubleValue.rounded()==amount.doubleValue
        else {throw SessionFailure.request}
      }
    }
    guard let url = URL(string:configuration.origin + "/user/api/v1/\(configuration.tenant)/subscription-purchase-operations" + suffix) else { throw SessionFailure.request }
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
