import Foundation
import XCTest
@testable import PadlHubSession

private final class TournamentMemoryStore: CredentialStore {
  var value: RefreshCredential?
  var written: ((RefreshCredential) -> Void)?
  func read() throws -> RefreshCredential? { value }
  func write(_ credential: RefreshCredential) throws { value = credential; written?(credential) }
  func clear() throws { value = nil }
}

final class TournamentRequestTests: XCTestCase {
  let id = "11111111-1111-4111-8111-111111111111"
  let key = "22222222-2222-4222-8222-222222222222"
  let dates = ["dateFrom":"2026-11-01","dateTo":"2026-11-16"]
  func config() throws -> SessionConfiguration {
    try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"synthetic",appVersion:"test",appBuild:"1")
  }
  var headers: [String:String] { ["Authorization":"Bearer synthetic-access","Idempotency-Key":key] }
  func command() -> SessionRequest {
    SessionRequest(operation:.tournament,headers:headers,body:"{\"action\":\"JOIN\"}",tournament:TournamentRequest(resource:"command",id:id))
  }
  func testFixedRoutesTokenlessDiscoveryAndOriginalOperation() throws {
    let read = try SessionRequest(operation:.tournament,tournament:TournamentRequest(resource:"list",query:dates)).urlRequest(configuration:config())
    XCTAssertEqual(read.httpMethod,"GET")
    XCTAssertEqual(read.url?.path,"/public/api/v1/synthetic/tournaments")
    XCTAssertNil(read.value(forHTTPHeaderField:"Authorization"));XCTAssertNil(read.value(forHTTPHeaderField:"Cookie"));XCTAssertNil(read.httpBody)
    let join=try command().urlRequest(configuration:config())
    XCTAssertEqual(join.httpMethod,"POST");XCTAssertEqual(join.value(forHTTPHeaderField:"Idempotency-Key"),key)
    XCTAssertEqual(String(data:join.httpBody!,encoding:.utf8),"{\"action\":\"JOIN\"}")
    let retry=try SessionRequest(operation:.tournament,headers:headers,tournament:TournamentRequest(resource:"retry",id:id,operationID:key)).urlRequest(configuration:config())
    XCTAssertEqual(retry.url?.path,"/user/api/v1/synthetic/tournaments/\(id)/registration-operations/\(key)/retry");XCTAssertNil(retry.httpBody)
    let status=try SessionRequest(operation:.tournament,headers:headers,tournament:TournamentRequest(resource:"status",id:id,operationID:key)).urlRequest(configuration:config())
    XCTAssertEqual(status.httpMethod,"GET");XCTAssertEqual(status.url?.query,"operationId=\(key)")
  }
  func testStrictDatesResourcesAndNoCredentialPublicReads() throws {
    for query in [["dateFrom":"2026-02-30","dateTo":"2026-03-02"],["dateFrom":"2026-11-01","dateTo":"2026-11-17"],["dateFrom":"2026-11-02","dateTo":"2026-11-01"],["dateFrom":"0000-01-01","dateTo":"0000-01-02"],["dateFrom":"2026-11-01","dateTo":"2026-11-02","clientId":"7"]] {
      XCTAssertThrowsError(try SessionRequest(operation:.tournament,tournament:TournamentRequest(resource:"list",query:query)).urlRequest(configuration:config()))
    }
    for resource in ["https://evil.invalid","games","waitlist"] {
      XCTAssertThrowsError(try SessionRequest(operation:.tournament,headers:headers,tournament:TournamentRequest(resource:resource,id:id)).urlRequest(configuration:config()))
    }
    XCTAssertThrowsError(try SessionRequest(operation:.tournament,headers:headers,tournament:TournamentRequest(resource:"list",query:dates)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.tournament,headers:["Cookie":"synthetic"],tournament:TournamentRequest(resource:"list",query:dates)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.tournament,headers:headers,tournament:TournamentRequest(resource:"status",id:"../other")).urlRequest(configuration:config()))
  }
  func testExactBodiesAndNoMixedOperationPayload() throws {
    for body in ["{}","null","{\"action\":\"JOIN\",\"gender\":\"MALE\"}","{\"action\":\"JOIN\",\"action\":\"JOIN\"}","{\"action\":\"LEAVE\"}"] {
      XCTAssertThrowsError(try SessionRequest(operation:.tournament,headers:headers,body:body,tournament:TournamentRequest(resource:"command",id:id)).urlRequest(configuration:config()))
    }
    let leave="{\"action\":\"LEAVE\",\"originalJoinOperationId\":\"\(key)\"}"
    XCTAssertEqual(try SessionRequest(operation:.tournament,headers:headers,body:leave,tournament:TournamentRequest(resource:"command",id:id)).urlRequest(configuration:config()).httpBody,Data(leave.utf8))
    XCTAssertThrowsError(try SessionRequest(operation:.tournament,headers:headers,body:"",tournament:TournamentRequest(resource:"retry",id:id,operationID:key)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.tournament,headers:headers,read:CabinetRead(resource:.home),tournament:TournamentRequest(resource:"status",id:id)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.read,headers:headers,read:CabinetRead(resource:.home),tournament:TournamentRequest(resource:"status",id:id)).urlRequest(configuration:config()))
  }
  func testTransportHasOneMutationAttemptOn401503AndNetworkFailure() async throws {
    for status in [401,503,0] {
      let store=TournamentMemoryStore()
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
  func testMissingSessionAndPendingLogoutNeverDispatchTournament() async throws {
    let store=TournamentMemoryStore()
    var sent=0
    let transport=SessionTransport(configuration:try config(),store:store) { _ in sent+=1;throw SessionFailure.network }
    let missing=try await transport.request(command());XCTAssertEqual(missing.status,401)
    store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:key)
    let pending=try await transport.request(command());XCTAssertEqual(pending.status,401);XCTAssertEqual(sent,0)
  }
  func testQueuedTournamentIsDeniedOnceLogoutIntentIsJournaled() async throws {
    let store=TournamentMemoryStore()
    store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600))
    let started=expectation(description:"read pending"), journaled=expectation(description:"logout journaled")
    journaled.assertForOverFulfill=false
    store.written={credential in if credential.logoutKey != nil {journaled.fulfill()}}
    var resume:CheckedContinuation<Void,Never>?
    var posts=0
    let transport=SessionTransport(configuration:try config(),store:store) { request in
      if request.httpMethod=="GET" {await withCheckedContinuation {resume=$0;started.fulfill()}}
      if request.httpMethod=="POST" {posts+=1}
      return (Data("{}".utf8),HTTPURLResponse(url:request.url!,statusCode:request.httpMethod=="DELETE" ? 204:200,httpVersion:nil,headerFields:[:])!)
    }
    let read=Task {try await transport.request(SessionRequest(operation:.read,headers:["Authorization":"Bearer synthetic-access"],read:CabinetRead(resource:.home)))}
    await fulfillment(of:[started],timeout:2)
    let queued=Task {try await transport.request(command())}
    let logout=Task {try await transport.request(SessionRequest(operation:.logout,headers:["Idempotency-Key":key,"X-Session-Intent":"logout"]))}
    await fulfillment(of:[journaled],timeout:2)
    resume?.resume();_ = try await read.value
    let denied=try await queued.value;XCTAssertEqual(denied.status,401)
    _ = try await logout.value;XCTAssertEqual(posts,0)
  }

}
