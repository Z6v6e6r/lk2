import Foundation
import XCTest
@testable import PadlHubSession
private final class TournamentStore: CredentialStore {
 var value:RefreshCredential?
 func read() throws -> RefreshCredential? {value}
 func write(_ v:RefreshCredential) throws {value=v}
 func clear() throws {value=nil}
}
final class TournamentChatRequestTests:XCTestCase {
 let id="11111111-1111-4111-8111-111111111111", key="22222222-2222-4222-8222-222222222222"
 func config() throws -> SessionConfiguration {try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"test",appVersion:"test",appBuild:"1")}
 func headers(_ write:Bool=true)->[String:String] {var h=["authorization":"Bearer synthetic.session"];if write {h["idempotency-key"]=key;h["content-type"]="application/json"};return h}
 func body()->String {"{\"requestId\":\"\(key)\",\"streamId\":\"\(id)\",\"witnessHash\":\"\(String(repeating:"a",count:64))\",\"throughSequence\":42}"}
 func request(_ resource:String) -> TournamentChatRequest {TournamentChatRequest(resource:resource,tournamentID:id,requestID:["send","read","status","readStatus"].contains(resource) ? key:nil)}
 func command() -> SessionRequest {SessionRequest(operation:.tournamentChat,headers:headers(),body:body(),tournamentChat:request("read"))}
 func sendBody(_ text:String) throws -> String {let data=try JSONSerialization.data(withJSONObject:text,options:.fragmentsAllowed);return "{\"requestId\":\"\(key)\",\"text\":\(String(data:data,encoding:.utf8)!)}"}
 func testSixRoutesAndBoundaries() throws {
  for (resource,suffix) in [("history","messages"),("position","read-position"),("status","message-requests/"+key),("readStatus","read-requests/"+key),("send","message-requests"),("read","read-requests")] {
   let write=["send","read"].contains(resource)
   let r=try request(resource).urlRequest(configuration:config(),headers:headers(write),body:write ? (resource=="send" ? try sendBody("hello"):body()):nil)
   XCTAssertEqual(r.httpMethod,write ? "POST":"GET");XCTAssertEqual(r.url?.path,"/user/api/v1/test/tournaments/\(id)/chat/"+suffix)
   XCTAssertEqual(r.value(forHTTPHeaderField:"Idempotency-Key"),write ? key:nil)
  }
 }
 func testStrictTupleAndMixedOperations() throws {
  for b in [body().replacingOccurrences(of:":42",with:":true"),body().replacingOccurrences(of:":42",with:":9007199254740991"),body().replacingOccurrences(of:":42",with:":4e2"),body().replacingOccurrences(of:":42",with:":\"42\""),body().replacingOccurrences(of:"}",with:",\"throughSequence\":42}")] {XCTAssertThrowsError(try request("read").urlRequest(configuration:config(),headers:headers(),body:b))}
  var h=headers();h["idempotency-key"]=id;XCTAssertThrowsError(try request("read").urlRequest(configuration:config(),headers:h,body:body()))
  XCTAssertThrowsError(try SessionRequest(operation:.stationMessage,headers:headers(),body:body(),tournamentChat:request("read")).urlRequest(configuration:config()))
  XCTAssertThrowsError(try SessionRequest(operation:.tournamentChat,headers:headers(),body:body(),read:CabinetRead(resource:.game,id:id),tournamentChat:request("read")).urlRequest(configuration:config()))
 }
 func testUnicodeDuplicateAndReadOnlyEnvelope() throws {
  for text in ["😀",String(repeating:"😀",count:4000),String(repeating:"漢",count:8000),"\u{0085}"] {_ = try request("send").urlRequest(configuration:config(),headers:headers(),body:sendBody(text))}
  for text in ["", " \u{FEFF}","\u{0000}",String(repeating:"😀",count:4001)] {XCTAssertThrowsError(try request("send").urlRequest(configuration:config(),headers:headers(),body:sendBody(text)))}
  for text in [#""\ud800""#,#""\udc00""#,#""a","text":"b""#] {XCTAssertThrowsError(try request("send").urlRequest(configuration:config(),headers:headers(),body:"{\"requestId\":\"\(key)\",\"text\":\(text)}"))}
  for q in [["limit":"51"],["cursor":String(repeating:"a",count:1801)],["cursor":"%61"],["phone":"1"]] {XCTAssertThrowsError(try TournamentChatRequest(resource:"history",tournamentID:id,query:q).urlRequest(configuration:config(),headers:headers(false),body:nil))}
  XCTAssertThrowsError(try request("history").urlRequest(configuration:config(),headers:headers(false),body:"{}"))
  var h=headers(false);h["cookie"]="synthetic";XCTAssertThrowsError(try request("history").urlRequest(configuration:config(),headers:h,body:nil))
 }
 func testAuthenticatedTransportNoRetryAndPendingLogout() async throws {
  let store=TournamentStore();var count=0
  let transport=SessionTransport(configuration:try config(),store:store){_ in count+=1;throw SessionFailure.network}
  let absent=try await transport.request(command());XCTAssertEqual(absent.status,401);XCTAssertEqual(count,0)
  store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:String(repeating:"l",count:20))
  let closed=try await transport.request(command());XCTAssertEqual(closed.status,401);XCTAssertEqual(count,0)
  store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600))
  do {_ = try await transport.request(command());XCTFail("network")}catch{}
  XCTAssertEqual(count,1)
 }
 func testHistoryOnlyThreeMiBAndRedirectRejected() async throws {
  for size in [2_400_000,3*1_048_576+1] {
   let store=TournamentStore();store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600))
   let transport=SessionTransport(configuration:try config(),store:store){request in (Data(repeating:32,count:size),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:[:])!)}
   for resource in ["history","position","status","readStatus"] {
    let input=SessionRequest(operation:.tournamentChat,headers:headers(false),tournamentChat:request(resource))
    do {let response=try await transport.request(input);XCTAssertEqual(resource,"history");XCTAssertLessThanOrEqual(size,3*1_048_576);XCTAssertEqual(response.body.utf8.count,size)}catch{XCTAssertTrue(resource != "history" || size>3*1_048_576)}
   }
   let redirect=SessionTransport(configuration:try config(),store:store){_ in (Data(),HTTPURLResponse(url:URL(string:"https://foreign.invalid/")!,statusCode:200,httpVersion:nil,headerFields:[:])!)}
   do {_ = try await redirect.request(command());XCTFail("redirect")}catch{}
  }
 }
}
