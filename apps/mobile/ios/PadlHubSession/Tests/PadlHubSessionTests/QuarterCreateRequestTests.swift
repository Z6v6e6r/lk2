import Foundation
import XCTest
@testable import PadlHubSession
private final class QuarterMemoryStore: CredentialStore {
  var value: RefreshCredential?
  func read() throws -> RefreshCredential? { value }
  func write(_ value: RefreshCredential) throws {self.value=value}
  func clear() throws {value=nil}
}
final class QuarterCreateRequestTests: XCTestCase {
  let id="11111111-1111-4111-8111-111111111111"
  let key="22222222-2222-4222-8222-222222222222"
  func config() throws -> SessionConfiguration {try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"synthetic",appVersion:"test",appBuild:"1")}
  var body:String {"{\"stationId\":\"\(id)\",\"courtId\":\"\(id)\",\"subscriptionId\":\"\(id)\",\"startsAt\":\"2030-01-01T12:00:00.000Z\"}"}
  var headers:[String:String] {["Authorization":"Bearer synthetic-access","Idempotency-Key":key]}
  func command() -> SessionRequest {SessionRequest(operation:.quarterCreate,headers:headers,body:body,quarterCreate:QuarterCreateRequest(resource:"create"))}
  func testFivePrivateRoutesAndExactOriginalBody() throws {
    for resource in ["capability","locations"] {
      let r=try SessionRequest(operation:.quarterCreate,headers:["Authorization":"Bearer synthetic-access"],quarterCreate:QuarterCreateRequest(resource:resource)).urlRequest(configuration:config())
      XCTAssertEqual(r.httpMethod,"GET");XCTAssertEqual(r.url?.path,"/user/api/v1/synthetic/game-create-operations/\(resource)");XCTAssertNil(r.value(forHTTPHeaderField:"Cookie"))
    }
    let read=try SessionRequest(operation:.quarterCreate,headers:headers,quarterCreate:QuarterCreateRequest(resource:"byKey")).urlRequest(configuration:config())
    XCTAssertEqual(read.value(forHTTPHeaderField:"Idempotency-Key"),key);XCTAssertNil(read.httpBody)
    let r=try command().urlRequest(configuration:config());XCTAssertEqual(r.httpMethod,"POST");XCTAssertEqual(r.httpBody,Data(body.utf8))
    let retry=try SessionRequest(operation:.quarterCreate,headers:headers,body:body,quarterCreate:QuarterCreateRequest(resource:"reconcile",operationID:id)).urlRequest(configuration:config())
    XCTAssertEqual(retry.url?.path,"/user/api/v1/synthetic/game-create-operations/\(id)/reconcile");XCTAssertEqual(retry.httpBody,r.httpBody)
  }
  func testInvalidIdentityResourceAndBodyAreDenied() throws {
    for resource in ["https://foreign.invalid","games","create?x=1","by-key"] {XCTAssertThrowsError(try SessionRequest(operation:.quarterCreate,headers:headers,body:body,quarterCreate:QuarterCreateRequest(resource:resource)).urlRequest(configuration:config()))}
    for invalid in ["{}",body.replacingOccurrences(of:"stationId",with:"courtId"),body.replacingOccurrences(of:"2030-01-01",with:"2030-02-30"),body.replacingOccurrences(of:"2030-01-01",with:"0000-01-01"),body.replacingOccurrences(of:"12:00:00",with:"12:00:01"),body.replacingOccurrences(of:"}",with:",\"price\":0}")] {
      XCTAssertThrowsError(try SessionRequest(operation:.quarterCreate,headers:headers,body:invalid,quarterCreate:QuarterCreateRequest(resource:"create")).urlRequest(configuration:config()))
    }
    var cookie=headers;cookie["Cookie"]="synthetic"
    XCTAssertThrowsError(try SessionRequest(operation:.quarterCreate,headers:cookie,body:body,quarterCreate:QuarterCreateRequest(resource:"create")).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.quarterCreate,headers:[:],body:body,quarterCreate:QuarterCreateRequest(resource:"create")).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.quarterCreate,headers:headers,body:body,quarterCreate:QuarterCreateRequest(resource:"reconcile",operationID:id+"\n")).urlRequest(configuration:config()))
  }
  func testNoMixedOperationOrReadBody() throws {
    XCTAssertThrowsError(try SessionRequest(operation:.read,headers:headers,read:CabinetRead(resource:.home),quarterCreate:QuarterCreateRequest(resource:"byKey")).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.quarterCreate,headers:headers,read:CabinetRead(resource:.home),quarterCreate:QuarterCreateRequest(resource:"byKey")).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.quarterCreate,headers:headers,body:"",quarterCreate:QuarterCreateRequest(resource:"byKey")).urlRequest(configuration:config()))
  }
  func testTransportDoesNotRetryMutation() async throws {
    for status in [401,503,0] {
      let store=QuarterMemoryStore();store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600))
      var sent=0
      let transport=SessionTransport(configuration:try config(),store:store) {request in sent+=1;XCTAssertEqual(request.httpMethod,"POST");if status==0 {throw SessionFailure.network};return(Data("{}".utf8),HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:[:])!)}
      do {let r=try await transport.request(command());XCTAssertEqual(r.status,status)} catch {XCTAssertEqual(status,0)}
      XCTAssertEqual(sent,1)
    }
  }
  func testMissingCredentialAndPendingLogoutNeverSend() async throws {
    let store=QuarterMemoryStore();var sent=0
    let transport=SessionTransport(configuration:try config(),store:store) {_ in sent+=1;throw SessionFailure.network}
    let noSession=try await transport.request(command());XCTAssertEqual(noSession.status,401)
    store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:key)
    let pending=try await transport.request(command());XCTAssertEqual(pending.status,401);XCTAssertEqual(sent,0)
  }
}
