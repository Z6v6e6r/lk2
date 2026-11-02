import Foundation
import XCTest
@testable import PadlHubSession
final class ProfileSettingsRequestTests:XCTestCase {
  let body="{\"expectedVersion\":0,\"contactPolicy\":\"NOBODY\",\"chatPolicy\":\"AUTHORIZED\"}"
  let preferences="{\"expectedVersion\":0,\"favoriteStationIds\":[],\"preferredTimeWindows\":[{\"weekday\":\"MON\",\"startsAt\":\"09:00\",\"endsAt\":\"12:00\"}],\"useHistory\":false,\"recommendFriends\":true,\"recommendationDisplay\":\"ROWS\"}"
  func config() throws -> SessionConfiguration {try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"synthetic",appVersion:"test",appBuild:"1")}
  func headers(_ resource:String="privacy")->[String:String] {["Authorization":"Bearer synthetic-access","Idempotency-Key":"profile-settings:"+resource+":"+String(repeating:"a",count:64),"Content-Type":"application/json"]}
  func testLevelHistoryIsOwnerReadWithBoundedLimit() throws {
    let read=CabinetRead(resource:.levelHistory,query:["limit":"100"])
    let r=try SessionRequest(operation:.read,headers:["Authorization":"Bearer synthetic-access"],read:read).urlRequest(configuration:config())
    XCTAssertEqual(r.httpMethod,"GET");XCTAssertEqual(r.url?.path,"/user/api/v1/synthetic/profile/level-history");XCTAssertNil(r.httpBody)
    for query in [["limit":"101"],["userId":"other"]] {XCTAssertThrowsError(try CabinetRead(resource:.levelHistory,query:query).url(configuration:config()))}
    XCTAssertThrowsError(try CabinetRead(resource:.levelHistory,id:"11111111-1111-4111-8111-111111111111").url(configuration:config()))
  }
  func testOwnedVersionedPutAndPreferences() throws {
    for (resource,value) in [("privacy",body),("preferences",preferences)] {
      let r=try SessionRequest(operation:.profileSettings,headers:headers(resource),body:value,profileSettings:ProfileSettingsRequest(resource:resource)).urlRequest(configuration:config())
      XCTAssertEqual(r.httpMethod,"PUT");XCTAssertEqual(r.httpBody,Data(value.utf8));XCTAssertFalse(r.httpShouldHandleCookies)
      XCTAssertEqual(r.url?.path,"/user/api/v1/synthetic/profile/"+(resource=="privacy" ? "privacy":"booking-preferences"))
      XCTAssertEqual(r.value(forHTTPHeaderField:"Idempotency-Key"),headers(resource)["Idempotency-Key"])
    }
  }
  func testDuplicateEscapedWrongTypesAndMixedCapabilitiesDenied() throws {
    for value in [body.replacingOccurrences(of:"\"expectedVersion\":0",with:"\"expectedVersion\":true"),body.replacingOccurrences(of:"\"expectedVersion\":0",with:"\"expectedVersion\":0,\"expectedVersion\":1"),body.replacingOccurrences(of:"expectedVersion",with:"expected\\u0056ersion"),body.replacingOccurrences(of:"\"NOBODY\"",with:"[\"NOBODY\"]")] {
      XCTAssertThrowsError(try SessionRequest(operation:.profileSettings,headers:headers(),body:value,profileSettings:ProfileSettingsRequest(resource:"privacy")).urlRequest(configuration:config()))
    }
    XCTAssertThrowsError(try SessionRequest(operation:.read,headers:headers(),read:CabinetRead(resource:.home),profileSettings:ProfileSettingsRequest(resource:"privacy")).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.profileSettings,headers:headers(),body:body,messaging:MessagingCommand(resource:"createGame"),profileSettings:ProfileSettingsRequest(resource:"privacy")).urlRequest(configuration:config()))
    XCTAssertThrowsError(try SessionRequest(operation:.profileSettings,headers:headers("preferences"),body:body,profileSettings:ProfileSettingsRequest(resource:"privacy")).urlRequest(configuration:config()))
  }
  func testInvalidPreferencesAndHeaderExpansionDenied() throws {
    for value in [preferences.replacingOccurrences(of:"\"useHistory\":false",with:"\"useHistory\":0"),preferences.replacingOccurrences(of:"09:00",with:"13:00"),preferences.replacingOccurrences(of:"\"ROWS\"",with:"[\"ROWS\"]")] {
      XCTAssertThrowsError(try SessionRequest(operation:.profileSettings,headers:headers("preferences"),body:value,profileSettings:ProfileSettingsRequest(resource:"preferences")).urlRequest(configuration:config()))
    }
    var h=headers();h["Cookie"]="synthetic"
    XCTAssertThrowsError(try SessionRequest(operation:.profileSettings,headers:h,body:body,profileSettings:ProfileSettingsRequest(resource:"privacy")).urlRequest(configuration:config()))
  }
}
