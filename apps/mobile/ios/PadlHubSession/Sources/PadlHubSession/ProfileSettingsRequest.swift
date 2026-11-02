import Foundation
import CoreFoundation

/// Two existing owner-scoped settings commands, never an arbitrary profile write.
public struct ProfileSettingsRequest: Sendable {
  public let resource: String
  public init(resource: String) {self.resource=resource}
  private func matches(_ value:String,_ pattern:String)->Bool {value.range(of:"\\A(?:"+pattern+")\\z",options:.regularExpression) != nil}
  private func integer(_ value:Any?)->Bool {guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID() else{return false};return n.doubleValue>=0 && n.doubleValue<=9007199254740991 && n.doubleValue.rounded(.towardZero)==n.doubleValue}
  private func boolean(_ value:Any?)->Bool {guard let n=value as? NSNumber else{return false};return CFGetTypeID(n)==CFBooleanGetTypeID()}
  private func count(_ key:String,_ body:String)->Int {guard let re=try? NSRegularExpression(pattern:"\""+key+"\"\\s*:") else{return -1};return re.numberOfMatches(in:body,range:NSRange(body.startIndex...,in:body))}
  func urlRequest(configuration:SessionConfiguration,headers:[String:String],body:String?) throws -> URLRequest {
    guard ["privacy","preferences"].contains(resource),let body,body.utf8.count<=8192,!body.contains("\\"),let data=body.data(using:.utf8),let v=try? JSONSerialization.jsonObject(with:data) as? [String:Any],integer(v["expectedVersion"]) else {throw SessionFailure.request}
    let keys:Set<String>=resource=="privacy" ? ["expectedVersion","contactPolicy","chatPolicy"] : ["expectedVersion","favoriteStationIds","preferredTimeWindows","useHistory","recommendFriends","recommendationDisplay"]
    guard Set(v.keys)==keys,keys.allSatisfy({count($0,body)==1}) else {throw SessionFailure.request}
    if resource=="privacy" {
      guard let contact=v["contactPolicy"] as? String,let chat=v["chatPolicy"] as? String,["AUTHORIZED","NOBODY"].contains(contact),["AUTHORIZED","NOBODY"].contains(chat) else {throw SessionFailure.request}
    } else {
      guard let stations=v["favoriteStationIds"] as? [String],stations.count<=3,Set(stations).count==stations.count,stations.allSatisfy({matches($0,"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")}),boolean(v["useHistory"]),boolean(v["recommendFriends"]),let display=v["recommendationDisplay"] as? String,["CARDS","ROWS"].contains(display),let windows=v["preferredTimeWindows"] as? [[String:Any]],windows.count<=14 else {throw SessionFailure.request}
      var seen=Set<String>()
      for window in windows {
        guard Set(window.keys)==["weekday","startsAt","endsAt"],let day=window["weekday"] as? String,["ANY","MON","TUE","WED","THU","FRI","SAT","SUN"].contains(day),let start=window["startsAt"] as? String,let end=window["endsAt"] as? String,matches(start,"(?:[01][0-9]|2[0-3]):[0-5][0-9]"),matches(end,"(?:[01][0-9]|2[0-3]):[0-5][0-9]"),start<end,seen.insert(day+":"+start+":"+end).inserted else {throw SessionFailure.request}
      }
      guard ["weekday","startsAt","endsAt"].allSatisfy({count($0,body)==windows.count}) else {throw SessionFailure.request}
    }
    let allowed:Set<String>=["authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"]
    var h:[String:String]=[:]
    for (name,value) in headers {let key=name.lowercased();guard allowed.contains(key),h[key]==nil,value.utf8.count<=8192,!value.contains("\r"),!value.contains("\n") else {throw SessionFailure.request};h[key]=value}
    guard let bearer=h["authorization"],matches(bearer,"Bearer [A-Za-z0-9._-]{8,8192}"),let key=h["idempotency-key"],matches(key,"profile-settings:"+resource+":[0-9a-f]{64}"),h["content-type"]=="application/json" else {throw SessionFailure.request}
    var url=URLComponents(string:configuration.origin)!;url.path="/user/api/v1/\(configuration.tenant)/profile/"+(resource=="privacy" ? "privacy":"booking-preferences")
    guard let target=url.url else {throw SessionFailure.request}
    var request=URLRequest(url:target,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:20);request.httpMethod="PUT";request.httpBody=data;request.httpShouldHandleCookies=false
    for(name,value) in h {request.setValue(value,forHTTPHeaderField:name)}
    request.setValue("application/json",forHTTPHeaderField:"Accept");request.setValue("ios",forHTTPHeaderField:"X-App-Platform");request.setValue(configuration.appVersion,forHTTPHeaderField:"X-App-Version");request.setValue(configuration.appBuild,forHTTPHeaderField:"X-App-Build")
    if h["x-correlation-id"]==nil {request.setValue(UUID().uuidString,forHTTPHeaderField:"X-Correlation-ID")}
    return request
  }
}
