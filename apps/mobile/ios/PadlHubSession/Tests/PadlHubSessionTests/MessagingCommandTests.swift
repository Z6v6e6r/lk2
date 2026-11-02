import Foundation
import XCTest
@testable import PadlHubSession

final class MessagingCommandTests: XCTestCase {
  func testDirectCreationAndOtherProfileAreExactAuthenticatedResources() throws {
    let body = "{\"otherUserId\":\"\(id)\"}"
    let command = MessagingCommand(resource: "createDirect")
    let request = try SessionRequest(operation: .messaging, headers: ["Authorization":"Bearer synthetic", "Idempotency-Key":key], body:body, messaging:command).urlRequest(configuration:configuration)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path, "/user/api/v1/synthetic/conversations/direct")
    XCTAssertFalse(request.httpShouldHandleCookies)
    XCTAssertEqual(request.value(forHTTPHeaderField:"Idempotency-Key"), key)
    XCTAssertThrowsError(try MessagingCommand(resource:"createDirect", id:id).path(configuration:configuration))
    for body in ["{}", "[]", "{\"otherUserId\":true}", "{\"otherUserId\":\"../x\"}", "{\"otherUserId\":\"\(id)\",\"tenant\":\"other\"}"] {
      XCTAssertThrowsError(try command.validatedBody(body, key:key))
    }
    for headers in [["Authorization":"Bearer synthetic"], ["Idempotency-Key":key]] {
      XCTAssertThrowsError(try SessionRequest(operation:.messaging, headers:headers, body:body, messaging:command).urlRequest(configuration:configuration))
    }
    let read = CabinetRead(resource:.playerProfile, id:id)
    XCTAssertEqual(try read.url(configuration:configuration).path, "/user/api/v1/synthetic/profiles/\(id)")
    XCTAssertThrowsError(try CabinetRead(resource:.playerProfile, id:id, query:["tenant":"other"]).url(configuration:configuration))
    XCTAssertThrowsError(try CabinetRead(resource:.playerProfile, id:"../x").url(configuration:configuration))
    XCTAssertThrowsError(try SessionRequest(operation:.read, read:read).urlRequest(configuration:configuration))
  }
  func testGameCreationUsesOnlyTheCanonicalGameCommand() throws {
    let body = "{\"gameId\":\"\(id)\"}"
    let command = MessagingCommand(resource: "createGame")
    let request = try SessionRequest(operation: .messaging, headers: ["Authorization":"Bearer synthetic", "Idempotency-Key":key], body:body, messaging:command).urlRequest(configuration:configuration)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path, "/user/api/v1/synthetic/conversations/game")
    XCTAssertFalse(request.httpShouldHandleCookies)
    XCTAssertEqual(request.value(forHTTPHeaderField:"Idempotency-Key"), key)
    XCTAssertThrowsError(try MessagingCommand(resource:"createGame", id:id).path(configuration:configuration))
    for body in ["{}", "[]", "{\"gameId\":true}", "{\"gameId\":\"../x\"}", "{\"gameId\":\"\(id)\",\"tenant\":\"other\"}"] {
      XCTAssertThrowsError(try command.validatedBody(body, key:key))
    }
    for headers in [["Authorization":"Bearer synthetic"], ["Idempotency-Key":key]] {
      XCTAssertThrowsError(try SessionRequest(operation:.messaging, headers:headers, body:body, messaging:command).urlRequest(configuration:configuration))
    }
  }
  func testMessagingPayloadCannotMixWithValidEarlyReturnOperations() throws {
    let dates = ["dateFrom":"2026-11-01", "dateTo":"2026-11-16"]
    let publicList = TournamentRequest(resource:"list",query:dates)
    XCTAssertNoThrow(try SessionRequest(operation:.tournament,tournament:publicList).urlRequest(configuration:configuration))
    XCTAssertThrowsError(try SessionRequest(operation:.tournament,tournament:publicList,messaging:MessagingCommand(resource:"createGame")).urlRequest(configuration:configuration))
    let headers = ["Authorization":"Bearer synthetic-access","Idempotency-Key":key]
    let body = "{\"reasonCode\":\"ORGANIZER_REQUEST\"}"
    let cancel = GameCancelRequest(gameID:id)
    XCTAssertNoThrow(try SessionRequest(operation:.gameCancel,headers:headers,body:body,gameCancel:cancel).urlRequest(configuration:configuration))
    XCTAssertThrowsError(try SessionRequest(operation:.gameCancel,headers:headers,body:body,gameCancel:cancel,messaging:MessagingCommand(resource:"createGame")).urlRequest(configuration:configuration))
  }
  let id = "00000000-0000-4000-8000-000000000001"
  let key = "synthetic-message-key"
  var configuration: SessionConfiguration {
    get throws { try SessionConfiguration(origin: "https://lk2.padlhub.su", tenant: "synthetic", appVersion: "test", appBuild: "1") }
  }
  func request(_ resource: String, _ body: String?, key: String? = "synthetic-message-key") throws -> URLRequest {
    var headers = ["Authorization": "Bearer synthetic"]
    if let key { headers["Idempotency-Key"] = key }
    return try SessionRequest(operation: .messaging, headers: headers, body: body,
      messaging: MessagingCommand(resource: resource, id: resource == "realtimeTicket" ? nil : id)
    ).urlRequest(configuration: configuration)
  }
  func testExactTextAndCursorRoutesPreserveCommandIdentityWithoutCookies() throws {
    let body = "{\"clientMessageId\":\"\(key)\",\"body\":\"Привет\"}"
    let send = try request("sendMessage", body)
    XCTAssertEqual(send.url?.path, "/user/api/v1/synthetic/conversations/\(id)/messages")
    XCTAssertEqual(send.httpMethod, "POST")
    XCTAssertEqual(send.value(forHTTPHeaderField: "Idempotency-Key"), key)
    XCTAssertEqual(send.httpBody, body.data(using: .utf8))
    XCTAssertNil(send.value(forHTTPHeaderField: "Cookie"))
    XCTAssertFalse(send.httpShouldHandleCookies)
    XCTAssertEqual(try request("messageReadCursor", "{\"throughSequence\":42}").httpMethod, "PUT")
    XCTAssertEqual(try request("conversationPolicy", "{\"level\":\"NONE\"}").httpMethod, "PUT")
    XCTAssertThrowsError(try request("sendMessage", body, key: nil))
  }
  func testTicketHasNoBodyIDOrCommandKey() throws {
    let ticket = try request("realtimeTicket", nil, key: nil)
    XCTAssertEqual(ticket.url?.path, "/user/api/v1/synthetic/messaging/realtime-ticket")
    XCTAssertNil(ticket.httpBody)
    XCTAssertThrowsError(try request("realtimeTicket", "{}", key: nil))
    XCTAssertThrowsError(try request("realtimeTicket", nil))
    XCTAssertThrowsError(try MessagingCommand(resource: "realtimeTicket", id: id).path(configuration: configuration))
  }
  func testConversationQueriesAndIDsAreDefaultDeny() throws {
    XCTAssertEqual(try CabinetRead(resource: .conversationMessages, id: id, query: ["afterSequence": "0", "limit": "100"]).url(configuration: configuration).path, "/user/api/v1/synthetic/conversations/\(id)/messages")
    let invalid = [
      CabinetRead(resource: .conversations, id: id),
      CabinetRead(resource: .conversations, query: ["tenant": "other"]),
      CabinetRead(resource: .conversations, query: ["limit": "101"]),
      CabinetRead(resource: .conversationMessages),
      CabinetRead(resource: .conversationMessages, id: "../other"),
      CabinetRead(resource: .conversationMessages, id: id, query: ["afterSequence": "9007199254740992"]),
      CabinetRead(resource: .conversationMessages, id: id, query: ["afterSequence": "-1"]),
      CabinetRead(resource: .conversationMessages, id: id, query: ["afterSequence": "1.5"]),
      CabinetRead(resource: .conversationMessages, id: id, query: ["afterSequence": "01"]),
    ]
    for read in invalid { XCTAssertThrowsError(try read.url(configuration: configuration)) }
    for resource in ["direct", "game", "media", "https://evil.test"] {
      XCTAssertThrowsError(try MessagingCommand(resource: resource, id: id).path(configuration: configuration))
    }
  }
  func testPayloadsRejectBooleansFractionsAttachmentsAndMismatchedIdentity() throws {
    for body in ["{\"throughSequence\":true}", "{\"throughSequence\":1.5}", "{\"throughSequence\":-1}", "{\"throughSequence\":9007199254740992}", "{\"throughSequence\":0,\"tenant\":\"other\"}"] {
      XCTAssertThrowsError(try request("messageReadCursor", body))
    }
    for body in ["[]", "null", "{", "{\"clientMessageId\":\"different-message-key\",\"body\":\"text\"}", "{\"clientMessageId\":\"\(key)\",\"body\":\" \"}", "{\"clientMessageId\":\"\(key)\",\"body\":\"text\",\"attachmentIds\":[]}", "{\"clientMessageId\":\"\(key)\",\"body\":\"\(String(repeating: "a", count: 8001))\"}"] {
      XCTAssertThrowsError(try request("sendMessage", body))
    }
    for body in ["{\"level\":\"INVALID\"}", "{\"level\":\"ALL\",\"mutedUntil\":true}", "{\"level\":\"ALL\",\"mutedUntil\":\"2000-01-01T00:00:00Z\"}", "{\"level\":\"ALL\",\"mutedUntil\":\"2099-01-01T00:00:00Z\"}"] {
      XCTAssertThrowsError(try request("conversationPolicy", body))
    }
  }
  func testMixedOperationsForeignHeadersAndAbsentAuthorizationAreRejected() throws {
    let command = MessagingCommand(resource: "realtimeTicket")
    for headers in [[:], ["Authorization": "Bearer synthetic", "Cookie": "private"], ["Authorization": "Bearer synthetic", "X-Tenant": "other"]] {
      XCTAssertThrowsError(try SessionRequest(operation: .messaging, headers: headers, messaging: command).urlRequest(configuration: configuration))
    }
    XCTAssertThrowsError(try SessionRequest(operation: .read, headers: ["Authorization": "Bearer synthetic"], read: CabinetRead(resource: .profile), messaging: command).urlRequest(configuration: configuration))
  }
}
