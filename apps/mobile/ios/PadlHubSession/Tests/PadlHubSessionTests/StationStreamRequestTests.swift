import Foundation
import XCTest
@testable import PadlHubSession
private final class StreamStore: CredentialStore {
 var value:RefreshCredential?
 func read() throws -> RefreshCredential? {value}
 func write(_ v:RefreshCredential) throws {value=v}
 func clear() throws {value=nil}
}
final class StationStreamRequestTests:XCTestCase {
 let id="11111111-1111-4111-8111-111111111111", key="22222222-2222-4222-8222-222222222222"
 func config() throws -> SessionConfiguration {try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"test",appVersion:"test",appBuild:"1")}
 func headers(_ write:Bool=true)->[String:String] {var h=["authorization":"Bearer synthetic.session"];if write {h["idempotency-key"]=key;h["content-type"]="application/json"};return h}
 func body()->String {"{\"requestId\":\"\(key)\",\"streamId\":\"\(id)\",\"membershipEpoch\":1,\"throughSequence\":42}"}
 func command() -> SessionRequest {SessionRequest(operation:.stationStream,headers:headers(),body:body(),stationStream:StationStreamRequest(resource:"read",communityID:id,requestID:key))}
 func testFourRoutesAndBoundaries() throws {
  let r=try command().urlRequest(configuration:config());XCTAssertEqual(r.httpMethod,"POST");XCTAssertEqual(r.url?.path,"/user/api/v1/test/community-views/\(id)/read-requests");XCTAssertEqual(r.value(forHTTPHeaderField:"Idempotency-Key"),key)
  let summary=try StationStreamRequest(resource:"summaries",query:["communityIds":id+","+key]).urlRequest(configuration:config(),headers:headers(false),body:nil);XCTAssertEqual(summary.httpMethod,"GET")
  _=try StationStreamRequest(resource:"stream",communityID:id,query:["limit":"50","cursor":String(repeating:"a",count:1024)]).urlRequest(configuration:config(),headers:headers(false),body:nil)
  _=try StationStreamRequest(resource:"readStatus",communityID:id,requestID:key).urlRequest(configuration:config(),headers:headers(false),body:nil)
 }
 func testStrictTupleAndMixedOperations() throws {
  let read=StationStreamRequest(resource:"read",communityID:id,requestID:key)
  for b in [body().replacingOccurrences(of:":42",with:":true"),body().replacingOccurrences(of:":42",with:":9007199254740991"),body().replacingOccurrences(of:":42",with:":4e2"),body().replacingOccurrences(of:":42",with:":\"42\""),body().replacingOccurrences(of:"}",with:",\"throughSequence\":42}"),body()+String(repeating:" ",count:16384)] {XCTAssertThrowsError(try read.urlRequest(configuration:config(),headers:headers(),body:b))}
  var h=headers();h["idempotency-key"]=id;XCTAssertThrowsError(try read.urlRequest(configuration:config(),headers:h,body:body()))
  XCTAssertThrowsError(try SessionRequest(operation:.stationMessage,headers:headers(),body:body(),stationStream:read).urlRequest(configuration:config()))
  XCTAssertThrowsError(try SessionRequest(operation:.stationStream,headers:headers(),body:body(),read:CabinetRead(resource:.game,id:id),stationStream:read).urlRequest(configuration:config()))
 }
 func testStrictSummaryCursorAndReadOnlyEnvelope() throws {
  for q in [["limit":"51"],["cursor":String(repeating:"a",count:1025)],["cursor":"%61"],["phone":"1"]] {XCTAssertThrowsError(try StationStreamRequest(resource:"stream",communityID:id,query:q).urlRequest(configuration:config(),headers:headers(false),body:nil))}
  for q in [["communityIds":id+","+id],["communityIds":id+"%2C"+key],[:]] {XCTAssertThrowsError(try StationStreamRequest(resource:"summaries",query:q).urlRequest(configuration:config(),headers:headers(false),body:nil))}
  XCTAssertThrowsError(try StationStreamRequest(resource:"readStatus",communityID:id,requestID:key,query:["limit":"1"]).urlRequest(configuration:config(),headers:headers(false),body:nil))
  XCTAssertThrowsError(try StationStreamRequest(resource:"stream",communityID:id).urlRequest(configuration:config(),headers:headers(false),body:"{}"))
 }
 func testAuthenticatedTransportNoRetryAndPendingLogout() async throws {
  let store=StreamStore();var count=0
  let transport=SessionTransport(configuration:try config(),store:store){_ in count+=1;throw SessionFailure.network}
  let absent=try await transport.request(command());XCTAssertEqual(absent.status,401);XCTAssertEqual(count,0)
  store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:String(repeating:"l",count:20))
  let closed=try await transport.request(command());XCTAssertEqual(closed.status,401);XCTAssertEqual(count,0)
  store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600))
  do {_ = try await transport.request(command());XCTFail("network")}catch{}
  XCTAssertEqual(count,1)
 }
 func testHistoryOnlyThreeMiBTransportCap() async throws {
  for size in [2_400_000,3*1_048_576+1] {
   let store=StreamStore();store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600))
   let transport=SessionTransport(configuration:try config(),store:store){request in (Data(repeating:32,count:size),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:[:])!)}
   let history=SessionRequest(operation:.stationStream,headers:headers(false),stationStream:StationStreamRequest(resource:"stream",communityID:id,query:["limit":"50"]))
   do {let response=try await transport.request(history);XCTAssertLessThanOrEqual(size,3*1_048_576);XCTAssertEqual(response.body.utf8.count,size)}catch{XCTAssertGreaterThan(size,3*1_048_576)}
   for resource in ["summaries","readStatus"] {
    let request=SessionRequest(operation:.stationStream,headers:headers(false),stationStream:StationStreamRequest(resource:resource,communityID:resource=="summaries" ? nil:id,requestID:resource=="readStatus" ? key:nil,query:resource=="summaries" ? ["communityIds":id]:[:]))
    do {_ = try await transport.request(request);XCTFail("lower cap") }catch{}
   }
  }
 }

}
