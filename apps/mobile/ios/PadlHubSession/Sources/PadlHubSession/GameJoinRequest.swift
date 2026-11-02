import Foundation
import CoreFoundation

/// A closed free/subscription JOIN and original-operation recovery surface.
public struct GameJoinRequest:Sendable {
  public let resource:String
  public let id:String
  public let query:[String:String]
  public init(resource:String,id:String,query:[String:String]=[:]){self.resource=resource;self.id=id;self.query=query}
  private func matches(_ v:String,_ p:String)->Bool {v.range(of:"\\A(?:"+p+")\\z",options:.regularExpression) != nil}
  private let uuid="[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  private func safeInteger(_ v:Any?)->Bool {guard let n=v as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID() else{return false};return n.doubleValue>=0&&n.doubleValue<=9007199254740991&&n.doubleValue.rounded(.towardZero)==n.doubleValue}
  private func validateBody(_ body:String?) throws {
    guard let body,body.utf8.count<=2048,!body.contains("\\"),let data=body.data(using:.utf8),let v=try? JSONSerialization.jsonObject(with:data) as? [String:Any],Set(v.keys).isSubset(of:["expectedRevision","invitationId","subscriptionInstanceId","priceConsent"]),safeInteger(v["expectedRevision"]) else{throw SessionFailure.request}
    if let invitation=v["invitationId"] {guard let value=invitation as? String,matches(value,uuid) else{throw SessionFailure.request}}
    var keys=Array(v.keys)
    if let subscription=v["subscriptionInstanceId"] {
      guard let value=subscription as? String,matches(value,uuid),let consent=v["priceConsent"] as? [String:Any],Set(consent.keys)==["amountMinor","currency"],safeInteger(consent["amountMinor"]),consent["currency"] as? String=="RUB" else{throw SessionFailure.request}
      keys += ["amountMinor","currency"]
    } else if v["priceConsent"] != nil {throw SessionFailure.request}
    for key in keys {let regex=try NSRegularExpression(pattern:"\""+key+"\"\\s*:");guard regex.numberOfMatches(in:body,range:NSRange(body.startIndex...,in:body))==1 else{throw SessionFailure.request}}
  }
  func urlRequest(configuration:SessionConfiguration,headers:[String:String],body:String?) throws -> URLRequest {
    guard matches(id,uuid) else{throw SessionFailure.request}
    let allowed:Set<String>=["authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"]
    var h:[String:String]=[:]
    for(name,value) in headers {let key=name.lowercased();guard allowed.contains(key),h[key]==nil,value.utf8.count<=8192,!value.contains("\r"),!value.contains("\n") else{throw SessionFailure.request};h[key]=value}
    guard let bearer=h["authorization"],matches(bearer,"Bearer [A-Za-z0-9._-]{8,8192}") else{throw SessionFailure.request}
    let path:String,method:String
    switch resource {
    case "conditions":
      guard body==nil,h["idempotency-key"]==nil,Set(query.keys)==["expectedRevision","subscriptionInstanceId"],let revision=query["expectedRevision"],matches(revision,"[0-9]+"),let n=Int64(revision),n>=0,n<=9007199254740991,let subscription=query["subscriptionInstanceId"],matches(subscription,uuid) else{throw SessionFailure.request}
      path="/games/\(id)/join-conditions";method="GET"
    case "join":try validateBody(body);path="/games/\(id)/join";method="POST"
    case "paidStatus":path="/games/\(id)/join-operation";method="GET"
    case "operation":path="/game-operations/\(id)";method="GET"
    case "reconcile":path="/game-operations/\(id)/reconcile";method="POST"
    default:throw SessionFailure.request
    }
    if resource != "conditions" {
      guard query.isEmpty,let key=h["idempotency-key"],matches(key,"[A-Za-z0-9][A-Za-z0-9._:-]{15,127}") else{throw SessionFailure.request}
      if resource == "reconcile" && key != "join-reconcile:\(id)" {throw SessionFailure.request}
    }
    if resource != "join" {guard body==nil,h["content-type"]==nil else{throw SessionFailure.request}}
    else {guard h["content-type"]==nil||h["content-type"]=="application/json" else{throw SessionFailure.request}}
    var url=URLComponents(string:configuration.origin)!;url.path="/user/api/v1/\(configuration.tenant)"+path
    if !query.isEmpty {url.queryItems=query.sorted(by:{$0.key<$1.key}).map{URLQueryItem(name:$0.key,value:$0.value)}}
    guard let destination=url.url else{throw SessionFailure.request}
    var request=URLRequest(url:destination,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:20);request.httpMethod=method;request.httpShouldHandleCookies=false
    for(name,value) in h {request.setValue(value,forHTTPHeaderField:name)}
    request.setValue("application/json",forHTTPHeaderField:"Accept");request.setValue("ios",forHTTPHeaderField:"X-App-Platform");request.setValue(configuration.appVersion,forHTTPHeaderField:"X-App-Version");request.setValue(configuration.appBuild,forHTTPHeaderField:"X-App-Build")
    if h["x-correlation-id"]==nil {request.setValue(UUID().uuidString,forHTTPHeaderField:"X-Correlation-ID")}
    // The existing reconcile API accepts an empty JSON object; avoid implicit form encoding.
    if resource == "reconcile" {request.httpBody=Data("{}".utf8);request.setValue("application/json",forHTTPHeaderField:"Content-Type")}
    else if let body {request.httpBody=Data(body.utf8);request.setValue("application/json",forHTTPHeaderField:"Content-Type")}
    return request
  }
}
