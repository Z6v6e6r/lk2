import Foundation
import XCTest
@testable import PadlHubSession
private final class CancelStore: CredentialStore {
 var value:RefreshCredential?
 func read() throws -> RefreshCredential? {value}
 func write(_ v:RefreshCredential) throws {value=v}
 func clear() throws {value=nil}
}
final class GameCancelRequestTests:XCTestCase {
 let id="11111111-1111-4111-8111-111111111111"
 let body="{\"reasonCode\":\"ORGANIZER_REQUEST\"}"
 let headers=["Authorization":"Bearer synthetic-access","Idempotency-Key":"synthetic-cancel-0001"]
 func config() throws -> SessionConfiguration {try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"synthetic",appVersion:"test",appBuild:"1")}
 func command() -> SessionRequest {SessionRequest(operation:.gameCancel,headers:headers,body:body,gameCancel:GameCancelRequest(gameID:id))}
 func testExactWireAndNoCookies() throws {
  let r=try command().urlRequest(configuration:config());XCTAssertEqual(r.httpMethod,"POST");XCTAssertEqual(r.url?.path,"/user/api/v1/synthetic/games/\(id)/cancel");XCTAssertEqual(r.httpBody,Data(body.utf8));XCTAssertFalse(r.httpShouldHandleCookies);XCTAssertEqual(r.value(forHTTPHeaderField:"Idempotency-Key"),headers["Idempotency-Key"])
 }
 func testRejectsMalformedTargetsAndBody() throws {
  for target in [id+"?force=1",id+"\n",id.replacingOccurrences(of:"-4111-",with:"-0111-"),"../../games"] {
   XCTAssertThrowsError(try GameCancelRequest(gameID:target).urlRequest(configuration:config(),headers:headers,body:body))
  }
  for value in ["{}","{\"reasonCode\":\"OTHER\"}","{\"reasonCode\":[\"ORGANIZER_REQUEST\"]}","{\"reasonCode\":\"ORGANIZER_REQUEST\",\"note\":\"x\"}","{\"reasonCode\":\"ORGANIZER_REQUEST\",\"reasonCode\":\"ORGANIZER_REQUEST\"}"] {
   XCTAssertThrowsError(try GameCancelRequest(gameID:id).urlRequest(configuration:config(),headers:headers,body:value))
  }
 }
 func testRejectsMixedOperationAndHeaders() throws {
  XCTAssertThrowsError(try SessionRequest(operation:.read,headers:headers,read:CabinetRead(resource:.game,id:id),gameCancel:GameCancelRequest(gameID:id)).urlRequest(configuration:config()))
  XCTAssertThrowsError(try SessionRequest(operation:.gameCancel,headers:headers,body:body,read:CabinetRead(resource:.game,id:id),gameCancel:GameCancelRequest(gameID:id)).urlRequest(configuration:config()))
  for name in ["Authorization","Idempotency-Key"] {var h=headers;h.removeValue(forKey:name);XCTAssertThrowsError(try GameCancelRequest(gameID:id).urlRequest(configuration:config(),headers:h,body:body))}
  var h=headers;h["Cookie"]="forbidden";XCTAssertThrowsError(try GameCancelRequest(gameID:id).urlRequest(configuration:config(),headers:h,body:body))
 }
 func testMissingSessionAndPendingLogoutNeverDispatch() async throws {
  let store=CancelStore();var sent=0
  let transport=SessionTransport(configuration:try config(),store:store){_ in sent+=1;throw SessionFailure.network}
  let missing=try await transport.request(command());XCTAssertEqual(missing.status,401)
  store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:"synthetic-logout-0001")
  let pending=try await transport.request(command());XCTAssertEqual(pending.status,401);XCTAssertEqual(sent,0)
 }
 func testTransportNeverRetriesMutation() async throws {
  for status in [0,401,503] {
   let store=CancelStore();store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600));var sent=0
   let transport=SessionTransport(configuration:try config(),store:store){r in sent+=1;if status==0 {throw SessionFailure.network};return(Data("{}".utf8),HTTPURLResponse(url:r.url!,statusCode:status,httpVersion:nil,headerFields:[:])!)}
   do {let r=try await transport.request(command());XCTAssertEqual(r.status,status)}catch{XCTAssertEqual(status,0)}
   XCTAssertEqual(sent,1)
  }
 }
}
