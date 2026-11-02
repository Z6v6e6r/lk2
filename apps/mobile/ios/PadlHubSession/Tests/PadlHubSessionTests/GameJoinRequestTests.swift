import Foundation
import XCTest
@testable import PadlHubSession
final class GameJoinRequestTests: XCTestCase {
  let id="11111111-1111-4111-8111-111111111111",key="22222222-2222-4222-8222-222222222222"
  var headers:[String:String]{["Authorization":"Bearer synthetic-access","Idempotency-Key":key]}
  func config() throws -> SessionConfiguration {try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"synthetic",appVersion:"test",appBuild:"1")}
  func testExactFreePaidAndNativeOwnedReconcileWire() throws {
    let free="{\"expectedRevision\":1}",paid="{\"expectedRevision\":1,\"subscriptionInstanceId\":\"\(key)\",\"priceConsent\":{\"amountMinor\":0,\"currency\":\"RUB\"}}"
    for body in [free,paid] {
      let r=try SessionRequest(operation:.gameJoin,headers:headers,body:body,gameJoin:GameJoinRequest(resource:"join",id:id)).urlRequest(configuration:config())
      XCTAssertEqual(r.httpMethod,"POST");XCTAssertEqual(r.httpBody,Data(body.utf8));XCTAssertEqual(r.value(forHTTPHeaderField:"Idempotency-Key"),key);XCTAssertFalse(r.httpShouldHandleCookies)
    }
    var h=headers;h["Idempotency-Key"]="join-reconcile:\(id)"
    let r=try SessionRequest(operation:.gameJoin,headers:h,gameJoin:GameJoinRequest(resource:"reconcile",id:id)).urlRequest(configuration:config())
    XCTAssertEqual(r.httpBody,Data("{}".utf8));XCTAssertEqual(r.value(forHTTPHeaderField:"Content-Type"),"application/json")
  }
  func testEscapedDuplicatesAndMixedRequestsAreDenied() throws {
    for body in ["{\"expectedRevision\":true}","{\"expectedRevision\":1,\"expectedRevision\":2}","{\"expectedRevision\":1,\"\\u0065xpectedRevision\":2}","{\"expectedRevision\":1,\"source\":\"viva\"}"] {
      XCTAssertThrowsError(try SessionRequest(operation:.gameJoin,headers:headers,body:body,gameJoin:GameJoinRequest(resource:"join",id:id)).urlRequest(configuration:config()))
    }
    XCTAssertThrowsError(try SessionRequest(operation:.gameJoin,headers:headers,messaging:MessagingCommand(resource:"createGame"),gameJoin:GameJoinRequest(resource:"paidStatus",id:id)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.read,headers:headers,read:CabinetRead(resource:.home),gameJoin:GameJoinRequest(resource:"paidStatus",id:id)).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.gameJoin,headers:headers,gameJoin:GameJoinRequest(resource:"reconcile",id:id)).urlRequest(configuration:config()))
  }
  func testConditionsAndStatusAreReadOnlyAndClosed() throws {
    let h=["Authorization":"Bearer synthetic-access"]
    let r=try SessionRequest(operation:.gameJoin,headers:h,gameJoin:GameJoinRequest(resource:"conditions",id:id,query:["expectedRevision":"1","subscriptionInstanceId":key])).urlRequest(configuration:config())
    XCTAssertEqual(r.httpMethod,"GET");XCTAssertNil(r.httpBody);XCTAssertNil(r.value(forHTTPHeaderField:"Idempotency-Key"))
    for resource in ["paidStatus","operation"] {
      let r=try SessionRequest(operation:.gameJoin,headers:headers,gameJoin:GameJoinRequest(resource:resource,id:id)).urlRequest(configuration:config());XCTAssertEqual(r.httpMethod,"GET");XCTAssertNil(r.httpBody)
      XCTAssertThrowsError(try SessionRequest(operation:.gameJoin,headers:headers,body:"{}",gameJoin:GameJoinRequest(resource:resource,id:id)).urlRequest(configuration:config()))
    }
    XCTAssertThrowsError(try SessionRequest(operation:.gameJoin,headers:headers,gameJoin:GameJoinRequest(resource:"conditions",id:id,query:["expectedRevision":"1","subscriptionInstanceId":key])).urlRequest(configuration:config()))
  }
}
