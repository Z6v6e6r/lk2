import Foundation
import XCTest
@testable import PadlHubSession

private final class TrainingMemoryStore: CredentialStore {
  var value: RefreshCredential?
  func read() throws -> RefreshCredential? { value }
  func write(_ credential: RefreshCredential) throws { value = credential }
  func clear() throws { value = nil }
}

final class TrainingRequestTests: XCTestCase {
  let id = "11111111-1111-4111-8111-111111111111"
  let key = "22222222-2222-4222-8222-222222222222"
  var headers: [String:String] { ["Authorization":"Bearer synthetic-access","Idempotency-Key":key] }
  var body: String { "{\"dateHint\":\"2035-04-02\",\"subscriptionId\":\"\(id)\"}" }
  func config() throws -> SessionConfiguration {
    try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"synthetic",appVersion:"test",appBuild:"1")
  }
  func command() -> SessionRequest {
    SessionRequest(operation:.training,headers:headers,body:body,training:TrainingRequest(resource:"register",id:id))
  }
  func testFixedCatalogueRegistrationAndOriginalStatusRoutes() throws {
    let query=["localDates":"2035-04-02,2035-04-03","kinds":"GROUP_TRAINING,SPLIT","availability":"INCLUDE_FULL","levelFrom":"C+"]
    let read=try SessionRequest(operation:.training,headers:["Authorization":"Bearer synthetic-access"],training:TrainingRequest(resource:"catalog",query:query)).urlRequest(configuration:config())
    XCTAssertEqual(read.httpMethod,"GET");XCTAssertEqual(read.url?.path,"/user/api/v1/synthetic/trainings/catalog")
    XCTAssertTrue(read.url!.absoluteString.contains("levelFrom=C%2B"))
    XCTAssertNil(read.httpBody);XCTAssertNil(read.value(forHTTPHeaderField:"Cookie"));XCTAssertFalse(read.httpShouldHandleCookies)
    let post=try command().urlRequest(configuration:config())
    XCTAssertEqual(post.httpMethod,"POST");XCTAssertEqual(post.url?.path,"/user/api/v1/synthetic/trainings/\(id)/registrations")
    XCTAssertEqual(post.httpBody,Data(body.utf8));XCTAssertEqual(post.value(forHTTPHeaderField:"Idempotency-Key"),key)
    let status=try SessionRequest(operation:.training,headers:headers,training:TrainingRequest(resource:"status",id:id)).urlRequest(configuration:config())
    XCTAssertEqual(status.httpMethod,"GET");XCTAssertEqual(status.url?.path,"/user/api/v1/synthetic/trainings/\(id)/registration-operation")
    XCTAssertEqual(status.value(forHTTPHeaderField:"Idempotency-Key"),key);XCTAssertNil(status.httpBody)
    let cursor=try SessionRequest(operation:.training,headers:["Authorization":"Bearer synthetic-access"],training:TrainingRequest(resource:"catalog",query:["cursor":id,"limit":"20"])).urlRequest(configuration:config())
    XCTAssertTrue(cursor.url!.absoluteString.contains("cursor=\(id)"))
  }
  func testInvalidQueryBodyAuthorityAndMixedPayloadAreRejected() throws {
    for query in [[String:String](),["cursor":id,"localDates":"2035-04-02"],["localDates":"2035-02-30","kinds":"SPLIT","availability":"INCLUDE_FULL"],["localDates":"0000-01-01","kinds":"SPLIT","availability":"INCLUDE_FULL"],["localDates":"2035-04-02,2035-04-02","kinds":"SPLIT","availability":"INCLUDE_FULL"],["cursor":id,"limit":"51"],["cursor":id,"url":"https://evil.invalid"]] {
      XCTAssertThrowsError(try SessionRequest(operation:.training,headers:["Authorization":"Bearer synthetic-access"],training:TrainingRequest(resource:"catalog",query:query)).urlRequest(configuration:config()))
    }
    for value in ["{}",body.replacingOccurrences(of:"2035-04-02",with:"2035-02-30"),String(body.dropLast())+",\"dateHint\":\"2035-04-02\"}",String(body.dropLast())+",\"clientId\":\"other\"}"] {
      XCTAssertThrowsError(try SessionRequest(operation:.training,headers:headers,body:value,training:TrainingRequest(resource:"register",id:id)).urlRequest(configuration:config()))
    }
    for resource in ["leave","https://evil.invalid","../catalog"] {
      XCTAssertThrowsError(try SessionRequest(operation:.training,headers:headers,training:TrainingRequest(resource:resource,id:id)).urlRequest(configuration:config()))
    }
    XCTAssertThrowsError(try SessionRequest(operation:.training,headers:headers,training:TrainingRequest(resource:"status",id:"../other")).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.training,headers:headers.merging(["Cookie":"synthetic"]){a,_ in a},body:body,training:TrainingRequest(resource:"register",id:id)).urlRequest(configuration:config()))
    // Valid positive controls precede mixed-operation rejection.
    XCTAssertNoThrow(try command().urlRequest(configuration:config()))
    XCTAssertNoThrow(try SessionRequest(operation:.read,headers:["Authorization":"Bearer synthetic-access"],read:CabinetRead(resource:.home)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.read,headers:["Authorization":"Bearer synthetic-access"],read:CabinetRead(resource:.home),training:TrainingRequest(resource:"status",id:id)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.training,headers:headers,body:body,messaging:MessagingCommand(resource:"createGame"),training:TrainingRequest(resource:"register",id:id)).urlRequest(configuration:config()))
  }
  func testTransportAttemptsMutationOnceWithoutRefreshOrReplay() async throws {
    for status in [401,503,0] {
      let store=TrainingMemoryStore()
      store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600))
      var sent=0
      let transport=SessionTransport(configuration:try config(),store:store) { request in
        sent+=1;XCTAssertEqual(request.httpMethod,"POST");XCTAssertNil(request.value(forHTTPHeaderField:"Cookie"))
        if status==0 {throw SessionFailure.network}
        return (Data("{}".utf8),HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:[:])!)
      }
      do {let response=try await transport.request(command());XCTAssertEqual(response.status,status)}
      catch {XCTAssertEqual(status,0)}
      XCTAssertEqual(sent,1)
    }
  }
  func testMissingSessionAndPendingLogoutNeverDispatch() async throws {
    let store=TrainingMemoryStore();var sent=0
    let transport=SessionTransport(configuration:try config(),store:store) { _ in sent+=1;throw SessionFailure.network }
    let missing=try await transport.request(command());XCTAssertEqual(missing.status,401)
    store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:key)
    let pending=try await transport.request(command());XCTAssertEqual(pending.status,401);XCTAssertEqual(sent,0)
  }
}
