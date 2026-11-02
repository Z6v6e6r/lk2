import Foundation
import XCTest
@testable import PadlHubSession
private final class SelfLeaveStore: CredentialStore {
  var value:RefreshCredential?
  func read() throws -> RefreshCredential? {value}
  func write(_ credential:RefreshCredential) throws {value=credential}
  func clear() throws {value=nil}
}
final class SelfLeaveRequestTests:XCTestCase {
  let id="11111111-1111-4111-8111-111111111111",key="22222222-2222-4222-8222-222222222222"
  var headers:[String:String]{["Authorization":"Bearer synthetic-access","Idempotency-Key":key]}
  func config() throws -> SessionConfiguration {try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"synthetic",appVersion:"test",appBuild:"1")}
  func command(_ resource:String="leave")->SessionRequest {SessionRequest(operation:.selfLeave,headers:headers,selfLeave:SelfLeaveRequest(resource:resource,gameID:id))}
  func testExactOriginalKeyRoutesWithoutBodyOrCookie() throws {
    for (resource,method,suffix) in [("leave","DELETE","participants/me"),("status","GET","leave-operation"),("reconcile","POST","leave-operation/reconcile")] {
      let r=try command(resource).urlRequest(configuration:config());XCTAssertEqual(r.httpMethod,method);XCTAssertEqual(r.url?.path,"/user/api/v1/synthetic/games/\(id)/\(suffix)")
      XCTAssertNil(r.httpBody);XCTAssertNil(r.value(forHTTPHeaderField:"Cookie"));XCTAssertFalse(r.httpShouldHandleCookies);XCTAssertEqual(r.value(forHTTPHeaderField:"Idempotency-Key"),key)
      if resource != "status" {XCTAssertEqual(r.value(forHTTPHeaderField:"Content-Type"),"text/plain")}
    }
  }
  func testExpandedBodiesResourcesAndMixedOperationsAreRejected() throws {
    for body in ["","{}","{\"member\":\"other\"}"] {XCTAssertThrowsError(try SessionRequest(operation:.selfLeave,headers:headers,body:body,selfLeave:SelfLeaveRequest(resource:"leave",gameID:id)).urlRequest(configuration:config()))}
    for resource in ["cancel","refund","https://evil.invalid"]{XCTAssertThrowsError(try command(resource).urlRequest(configuration:config()))}
    XCTAssertThrowsError(try SessionRequest(operation:.selfLeave,headers:headers,selfLeave:SelfLeaveRequest(resource:"leave",gameID:"../other")).urlRequest(configuration:config()))
    XCTAssertNoThrow(try command().urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.selfLeave,headers:headers,messaging:MessagingCommand(resource:"createGame"),selfLeave:SelfLeaveRequest(resource:"leave",gameID:id)).urlRequest(configuration:config()))
    let readHeaders=["Authorization":"Bearer synthetic-access"]
    XCTAssertNoThrow(try SessionRequest(operation:.read,headers:readHeaders,read:CabinetRead(resource:.home)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.read,headers:readHeaders,read:CabinetRead(resource:.home),selfLeave:SelfLeaveRequest(resource:"leave",gameID:id)).urlRequest(configuration:config()))
  }
  func testNoRetryOnNetwork401503() async throws {
    for status in [0,401,503] {
      let store=SelfLeaveStore();store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600));var sent=0
      let transport=SessionTransport(configuration:try config(),store:store){request in sent+=1;XCTAssertEqual(request.httpMethod,"DELETE");if status==0{throw SessionFailure.network};return(Data("{}".utf8),HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:[:])!)}
      do{let response=try await transport.request(command());XCTAssertEqual(response.status,status)}catch{XCTAssertEqual(status,0)};XCTAssertEqual(sent,1)
    }
  }
  func testMissingSessionAndPendingLogoutSuppressHTTP() async throws {
    let store=SelfLeaveStore();var sent=0;let transport=SessionTransport(configuration:try config(),store:store){_ in sent+=1;throw SessionFailure.network}
    let absent=try await transport.request(command());XCTAssertEqual(absent.status,401)
    store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:key)
    let pending=try await transport.request(command());XCTAssertEqual(pending.status,401);XCTAssertEqual(sent,0)
  }
}
