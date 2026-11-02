import Foundation

/// Existing training owner contract; never accepts a caller URL, tenant or HTTP method.
public struct TrainingRequest: Sendable {
  public let resource: String
  public let id: String?
  public let query: [String:String]
  public init(resource:String,id:String?=nil,query:[String:String]=[:]) {
    self.resource=resource; self.id=id; self.query=query
  }
  private let uuid="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
  private func matches(_ value:String,_ pattern:String)->Bool {
    value.range(of:"\\A(?:"+pattern+")\\z",options:.regularExpression) != nil
  }
  private func day(_ value:String)->Bool {
    guard matches(value,"[0-9]{4}-[0-9]{2}-[0-9]{2}"), !value.hasPrefix("0000") else {return false}
    let parser=DateFormatter();parser.locale=Locale(identifier:"en_US_POSIX");parser.calendar=Calendar(identifier:.gregorian)
    parser.timeZone=TimeZone(secondsFromGMT:0);parser.dateFormat="yyyy-MM-dd";parser.isLenient=false
    guard let date=parser.date(from:value) else {return false};return parser.string(from:date)==value
  }
  private func catalogueValid()->Bool {
    guard query.reduce(0,{$0+$1.key.utf8.count+$1.value.utf8.count})<=8192 else {return false}
    for (name,value) in query {
      switch name {
      case "limit": if !matches(value,"[1-9]|[1-4][0-9]|50") {return false}
      case "cursor": if !matches(value,uuid) {return false}
      case "localDates":
        let dates=value.components(separatedBy:",")
        if dates.count>7 || Set(dates).count != dates.count || !dates.allSatisfy({day($0)}) {return false}
      case "kinds": if !matches(value,"(?:COACH_GAME|GROUP_TRAINING|SPLIT)(?:,(?:COACH_GAME|GROUP_TRAINING|SPLIT)){0,2}") {return false}
      case "categoryIds","stationIds": if !matches(value,uuid+"(?:,"+uuid+"){0,49}") {return false}
      case "availability": if !["INCLUDE_FULL","EXCLUDE_FULL"].contains(value) {return false}
      case "levelFrom","levelTo": if !matches(value,"D\\+?|C\\+?|B\\+?|A") {return false}
      case "startsAfterLocal": if !matches(value,"(?:[01][0-9]|2[0-3]):[0-5][0-9]") {return false}
      default:return false
      }
    }
    if query["cursor"] != nil {return query.count == (query["limit"] != nil ? 2:1)}
    return query["localDates"] != nil && query["kinds"] != nil && query["availability"] != nil
  }
  func urlRequest(configuration:SessionConfiguration,headers:[String:String],body:String?) throws -> URLRequest {
    let suffix:String
    let method:String
    switch resource {
    case "catalog":
      guard id == nil, body == nil, catalogueValid() else {throw SessionFailure.request}
      suffix="/catalog";method="GET"
    case "register","status":
      guard let id,matches(id,uuid),query.isEmpty else {throw SessionFailure.request}
      if resource=="status" {
        guard body == nil else {throw SessionFailure.request};suffix="/\(id)/registration-operation";method="GET"
      } else {
        guard let body,body.utf8.count<=256 else {throw SessionFailure.request}
        let date="\"dateHint\"\\s*:\\s*\"[0-9]{4}-[0-9]{2}-[0-9]{2}\""
        let sub="\"subscriptionId\"\\s*:\\s*\""+uuid+"\""
        guard matches(body,"\\s*\\{\\s*(?:"+date+"\\s*,\\s*"+sub+"|"+sub+"\\s*,\\s*"+date+")\\s*\\}\\s*"),
          let data=body.data(using:.utf8),let object=try? JSONSerialization.jsonObject(with:data) as? [String:String],
          let hint=object["dateHint"],day(hint) else {throw SessionFailure.request}
        suffix="/\(id)/registrations";method="POST"
      }
    default:throw SessionFailure.request
    }
    let allowed:Set<String>=["accept","content-type","authorization","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"]
    var normalized:[String:String]=[:]
    for(name,value) in headers {
      let key=name.lowercased()
      guard allowed.contains(key),normalized[key]==nil,value.utf8.count<=8192,!value.contains("\r"),!value.contains("\n") else {throw SessionFailure.request}
      normalized[key]=value
    }
    guard let bearer=normalized["authorization"],matches(bearer,"Bearer [A-Za-z0-9._-]{8,8192}") else {throw SessionFailure.request}
    if resource=="catalog" {
      guard normalized["idempotency-key"]==nil else {throw SessionFailure.request}
    } else {
      guard let key=normalized["idempotency-key"],matches(key,"[A-Za-z0-9][A-Za-z0-9._:-]{15,127}") else {throw SessionFailure.request}
    }
    var url=URLComponents(string:configuration.origin)!
    url.path="/user/api/v1/\(configuration.tenant)/trainings"+suffix
    if !query.isEmpty {
      url.queryItems=query.sorted(by:{$0.key<$1.key}).map{URLQueryItem(name:$0.key,value:$0.value)}
      // Form query decoders treat a literal plus as a space. Preserve level C+/B+/D+.
      url.percentEncodedQuery=url.percentEncodedQuery?.replacingOccurrences(of:"+",with:"%2B")
    }
    guard let destination=url.url else {throw SessionFailure.request}
    var request=URLRequest(url:destination,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:20)
    request.httpMethod=method;request.httpShouldHandleCookies=false
    for(name,value) in normalized {request.setValue(value,forHTTPHeaderField:name)}
    request.setValue("application/json",forHTTPHeaderField:"Accept")
    request.setValue("ios",forHTTPHeaderField:"X-App-Platform")
    request.setValue(configuration.appVersion,forHTTPHeaderField:"X-App-Version")
    request.setValue(configuration.appBuild,forHTTPHeaderField:"X-App-Build")
    if normalized["x-correlation-id"]==nil {request.setValue(UUID().uuidString,forHTTPHeaderField:"X-Correlation-ID")}
    if let body {request.httpBody=body.data(using:.utf8);request.setValue("application/json",forHTTPHeaderField:"Content-Type")}
    return request
  }
}
