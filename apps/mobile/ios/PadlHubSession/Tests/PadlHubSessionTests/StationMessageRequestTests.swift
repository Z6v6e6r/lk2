import Foundation
import XCTest
@testable import PadlHubSession
private final class StationStore: CredentialStore {
 var value:RefreshCredential?
 func read() throws -> RefreshCredential? {value}
 func write(_ v:RefreshCredential) throws {value=v}
 func clear() throws {value=nil}
}
final class StationMessageRequestTests:XCTestCase {
 let id="11111111-1111-4111-8111-111111111111", key="22222222-2222-4222-8222-222222222222"
 func config() throws -> SessionConfiguration {try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"test",appVersion:"test",appBuild:"1")}
 func headers(_ send:Bool=true)->[String:String] {var h=["authorization":"Bearer synthetic.session"];if send {h["idempotency-key"]=key;h["content-type"]="application/json"};return h}
 func body(_ text:String) throws -> String {let quoted=String(data:try JSONSerialization.data(withJSONObject:[text]),encoding:.utf8)!;return "{\"requestId\":\"\(key)\",\"text\":"+String(quoted.dropFirst().dropLast())+"}"}
 func command(_ text:String="hello") throws -> SessionRequest {SessionRequest(operation:.stationMessage,headers:headers(),body:try body(text),stationMessage:StationMessageRequest(resource:"send",communityID:id,requestID:key))}
 func testExactSendReadAndUnicodeBounds() throws {
  for text in ["hello",String(repeating:"я",count:8000),String(repeating:"😀",count:4000),String(repeating:"\n",count:7999)+"a"] {
   let r=try command(text).urlRequest(configuration:config());XCTAssertEqual(r.httpMethod,"POST");XCTAssertEqual(r.url?.path,"/user/api/v1/test/community-views/\(id)/message-requests");XCTAssertFalse(r.httpShouldHandleCookies);XCTAssertEqual(r.value(forHTTPHeaderField:"Idempotency-Key"),key)
  }
  let history=try StationMessageRequest(resource:"history",communityID:id,query:["limit":"50","cursor":String(repeating:"a",count:20)]).urlRequest(configuration:config(),headers:headers(false),body:nil)
  XCTAssertEqual(history.httpMethod,"GET");XCTAssertNil(history.httpBody)
  let status=try StationMessageRequest(resource:"status",communityID:id,requestID:key).urlRequest(configuration:config(),headers:headers(false),body:nil);XCTAssertTrue(status.url!.path.hasSuffix(key))
 }
 func testStrictBodyTargetsHeadersAndMixedOperations() throws {
  for text in [String(repeating:"a",count:8001)," \t\n",String(repeating:"😀",count:4001)] {XCTAssertThrowsError(try command(text).urlRequest(configuration:config()))}
  let send=StationMessageRequest(resource:"send",communityID:id,requestID:key)
  for value in ["{}",try body("x")+"{}",try body("x").replacingOccurrences(of:"}",with:",\"actor\":\"x\"}"),try body("x").replacingOccurrences(of:"}",with:",\"text\":\"x\"}")] {XCTAssertThrowsError(try send.urlRequest(configuration:config(),headers:headers(),body:value))}
  for target in [id+"\n",id+"?x=1",id.replacingOccurrences(of:"-4111-",with:"-0111-"),"../../games"] {XCTAssertThrowsError(try StationMessageRequest(resource:"send",communityID:target,requestID:key).urlRequest(configuration:config(),headers:headers(),body:body("x")))}
  for name in ["authorization","idempotency-key","content-type"] {var h=headers();h.removeValue(forKey:name);XCTAssertThrowsError(try send.urlRequest(configuration:config(),headers:h,body:body("x")))}
  var h=headers();h["idempotency-key"]=id;XCTAssertThrowsError(try send.urlRequest(configuration:config(),headers:h,body:body("x")))
  h=headers();h["cookie"]="forbidden";XCTAssertThrowsError(try send.urlRequest(configuration:config(),headers:h,body:body("x")))
  XCTAssertThrowsError(try SessionRequest(operation:.read,headers:headers(),read:CabinetRead(resource:.game,id:id),stationMessage:send).urlRequest(configuration:config()))
  XCTAssertThrowsError(try SessionRequest(operation:.stationMessage,headers:headers(),body:body("x"),read:CabinetRead(resource:.game,id:id),stationMessage:send).urlRequest(configuration:config()))
 }
 func testStrictReads() throws {
  for query in [["limit":"51"],["cursor":"%61"],["phone":"1"],["limit":"01"]] {XCTAssertThrowsError(try StationMessageRequest(resource:"history",communityID:id,query:query).urlRequest(configuration:config(),headers:headers(false),body:nil))}
  XCTAssertThrowsError(try StationMessageRequest(resource:"status",communityID:id,requestID:key,query:["limit":"1"]).urlRequest(configuration:config(),headers:headers(false),body:nil))
  XCTAssertThrowsError(try StationMessageRequest(resource:"history",communityID:id).urlRequest(configuration:config(),headers:headers(false),body:"{}"))
 }
 func testNoSessionOrPendingLogoutNoSendAndNoNetworkRetry() async throws {
  let store=StationStore();var count=0
  let transport=SessionTransport(configuration:try config(),store:store){_ in count+=1;throw SessionFailure.network}
  let absent=try await transport.request(command());XCTAssertEqual(absent.status,401);XCTAssertEqual(count,0)
  store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:String(repeating:"l",count:20))
  let closed=try await transport.request(command());XCTAssertEqual(closed.status,401);XCTAssertEqual(count,0)
  store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600))
  do {_ = try await transport.request(command());XCTFail("network")}catch{}
  XCTAssertEqual(count,1)
 }
}
