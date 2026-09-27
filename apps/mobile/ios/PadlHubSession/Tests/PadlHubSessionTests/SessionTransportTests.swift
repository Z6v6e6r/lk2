import Foundation
import Security
import XCTest

@testable import PadlHubSession

private final class MemoryStore: CredentialStore {
  var value: RefreshCredential?
  var rejectWrites = false
  var rejectSuccessor = false
  func read() throws -> RefreshCredential? { value }
  func write(_ credential: RefreshCredential) throws {
    if rejectWrites || (rejectSuccessor && credential.refreshKey == nil) {
      throw SessionFailure.storage
    }
    value = credential
  }
  func clear() throws { value = nil }
}

final class SessionTransportTests: XCTestCase {
  private let origin = "https://lk2.padlhub.su"
  private let tenant = "local-padel"
  private let oldToken = String(repeating: "a", count: 43)
  private let nextToken = String(repeating: "b", count: 43)
  private let key = "11111111-1111-4111-8111-111111111111"
  private let anotherKey = "22222222-2222-4222-8222-222222222222"
  private let challenge = "33333333-3333-4333-8333-333333333333"
  private let sessionBody =
    "{\"accessToken\":\"short-lived-access\",\"tokenType\":\"Bearer\",\"expiresAt\":\"2099-01-01T00:00:00Z\",\"user\":{\"id\":\"synthetic-user\",\"displayName\":\"Test\"},\"context\":{\"userId\":\"synthetic-user\",\"tenantId\":\"synthetic-tenant\"}}"

  private func configuration() throws -> SessionConfiguration {
    try SessionConfiguration(origin: origin, tenant: tenant, appVersion: "1.0", appBuild: "1")
  }

  private func stored() throws -> MemoryStore {
    let store = MemoryStore()
    store.value = RefreshCredential(
      version: 1, scope: try configuration().keychainScope,
      value: oldToken, expiresAt: Date().addingTimeInterval(3600))
    return store
  }

  private func input(_ operation: SessionOperation, key: String? = nil) -> SessionRequest {
    var headers = ["Idempotency-Key": key ?? self.key]
    if operation == .refresh { headers["X-Session-Intent"] = "refresh" }
    if operation == .logout { headers["X-Session-Intent"] = "logout" }
    return SessionRequest(operation: operation, headers: headers)
  }

  private func cookie(_ value: String) -> String {
    "phub_refresh=\(value); Max-Age=3600; Path=/user/api/v1/\(tenant)/auth; HttpOnly; Secure; SameSite=Lax"
  }

  private func response(
    _ request: URLRequest, status: Int = 200, cookie: String? = nil,
    body: String? = nil
  ) -> (Data, HTTPURLResponse) {
    var headers = ["Content-Type": "application/json", "X-Correlation-ID": "synthetic-correlation"]
    if let cookie { headers["Set-Cookie"] = cookie }
    return (
      Data((body ?? sessionBody).utf8),
      HTTPURLResponse(
        url: request.url!, statusCode: status,
        httpVersion: "HTTP/1.1", headerFields: headers)!
    )
  }

  func testConfigurationRejectsOtherOriginsAndTenantTraversal() throws {
    for origin in [
      "http://lk2.padlhub.su", "https://lk2.padlhub.su/", "https://lk2.padlhub.su:443",
      "https://lk2.padlhub.su.evil.test", "https://user@lk2.padlhub.su", "https://vivacrm.ru",
    ] {
      XCTAssertThrowsError(
        try SessionConfiguration(origin: origin, tenant: tenant, appVersion: "1", appBuild: "1"))
    }
    for tenant in ["../other", "a/b", "a%2fb", "a?b", "a#b", "a", "A-test", "a_test", ""] {
      XCTAssertThrowsError(
        try SessionConfiguration(origin: origin, tenant: tenant, appVersion: "1", appBuild: "1"))
    }
  }

  func testStagingOriginIsDebugOnly() throws {
    #if DEBUG
      XCTAssertNoThrow(
        try SessionConfiguration(
          origin: "https://lk.nano.padlhub.su", tenant: tenant, appVersion: "1", appBuild: "1"))
    #else
      XCTAssertThrowsError(
        try SessionConfiguration(
          origin: "https://lk.nano.padlhub.su", tenant: tenant, appVersion: "1", appBuild: "1"))
    #endif
  }

  func testHeadersBodyAndChallengeAreDefaultDeny() throws {
    for name in ["Cookie", "Origin", "Host", "Set-Cookie", "Proxy-Authorization", "Authorization"] {
      let input = SessionRequest(
        operation: .refresh,
        headers: [name: "secret", "Idempotency-Key": key, "X-Session-Intent": "refresh"])
      XCTAssertThrowsError(try input.urlRequest(configuration: configuration()))
    }
    for id in ["../session", "%2fcontext", challenge + "?x=1", ""] {
      XCTAssertThrowsError(
        try SessionRequest(operation: .verify, challengeID: id).urlRequest(
          configuration: configuration()))
    }
    for body in [
      "{\"method\":\"phone_otp\",\"phone\":\"+7999\"}",
      "{\"method\":\"email\",\"phone\":\"+70000000000\"}",
    ] {
      XCTAssertThrowsError(
        try SessionRequest(operation: .challenge, headers: ["Idempotency-Key": key], body: body)
          .urlRequest(configuration: configuration()))
    }
    for code in ["123", "123456", "12ab"] {
      let body =
        "{\"code\":\"\(code)\",\"acceptance\":{\"publicOfferAccepted\":true,\"personalDataPolicyAccepted\":true}}"
      XCTAssertThrowsError(
        try SessionRequest(
          operation: .verify, challengeID: challenge,
          headers: ["Idempotency-Key": key], body: body
        ).urlRequest(configuration: configuration()))
    }
    let native = try input(.refresh).urlRequest(configuration: configuration())
    XCTAssertNil(native.value(forHTTPHeaderField: "Origin"))
    XCTAssertNil(native.value(forHTTPHeaderField: "Cookie"))
    XCTAssertEqual(native.value(forHTTPHeaderField: "X-App-Platform"), "ios")
  }

  func testSessionHasNoSharedCookieCredentialOrCacheStore() {
    let settings = SessionTransport.urlSessionConfiguration()
    XCTAssertNil(settings.httpCookieStorage)
    XCTAssertNil(settings.urlCredentialStorage)
    XCTAssertNil(settings.urlCache)
    XCTAssertFalse(settings.httpShouldSetCookies)
    XCTAssertEqual(settings.timeoutIntervalForResource, 30)
  }

  func testAcceptsSDKFallbackKeysOnOlderWebViewsAndRejectsInvalidKeys() throws {
    let fallback = "phub-testclock-1-syntheticrequest"
    let request = try input(.refresh, key: fallback).urlRequest(configuration: configuration())
    XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), fallback)
    for key in ["short", "0123456789abcdef?", String(repeating: "a", count: 129)] {
      XCTAssertThrowsError(try input(.refresh, key: key).urlRequest(configuration: configuration()))
    }
  }

  func testRedirectDelegateRejectsCrossOriginAndSameOriginRedirects() throws {
    let session = URLSession(configuration: SessionTransport.urlSessionConfiguration())
    defer { session.invalidateAndCancel() }
    let original = try input(.refresh).urlRequest(configuration: configuration())
    let task = session.dataTask(with: original)
    let response = response(original, status: 302).1
    for destination in [origin + "/elsewhere", "https://evil.test"] {
      RejectRedirects().urlSession(
        session, task: task, willPerformHTTPRedirection: response,
        newRequest: URLRequest(url: URL(string: destination)!)
      ) { redirected in
        XCTAssertNil(redirected)
      }
    }
  }

  func testEmptyOrExpiredSessionNeverSendsNetworkRequest() async throws {
    let store = try stored()
    store.value = RefreshCredential(
      version: 1, scope: try configuration().keychainScope, value: oldToken, expiresAt: .distantPast
    )
    let client = SessionTransport(configuration: try configuration(), store: store) { _ in
      XCTFail("Expired credential must not leave the device")
      throw SessionFailure.network
    }
    let response = try await client.request(input(.refresh))
    XCTAssertEqual(response.status, 401)
    XCTAssertNil(store.value)
    let second = try await client.request(input(.refresh))
    XCTAssertEqual(second.status, 401)
  }

  func testVerifyPersistsCookieBeforeReturningAccessAndNeverBridgesCookie() async throws {
    let store = MemoryStore()
    let client = SessionTransport(configuration: try configuration(), store: store) { request in
      XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      return self.response(request, cookie: self.cookie(self.nextToken))
    }
    let body =
      "{\"code\":\"1234\",\"acceptance\":{\"publicOfferAccepted\":true,\"personalDataPolicyAccepted\":true}}"
    let response = try await client.request(
      SessionRequest(
        operation: .verify, challengeID: challenge,
        headers: ["Idempotency-Key": key], body: body))
    XCTAssertEqual(store.value?.value, nextToken)
    XCTAssertEqual(response.status, 200)
    XCTAssertNil(response.headers["Set-Cookie"])
    XCTAssertFalse(response.body.contains(nextToken))
  }

  func testRotationPersistsSuccessorAndColdStartUsesIt() async throws {
    let store = try stored()
    let first = SessionTransport(configuration: try configuration(), store: store) { request in
      XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "phub_refresh=\(self.oldToken)")
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      XCTAssertEqual(store.value?.refreshKey, self.key)
      return self.response(request, cookie: self.cookie(self.nextToken))
    }
    _ = try await first.request(input(.refresh))
    XCTAssertEqual(store.value?.value, nextToken)
    XCTAssertNil(store.value?.refreshKey)
    let restarted = SessionTransport(configuration: try configuration(), store: store) { request in
      XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "phub_refresh=\(self.nextToken)")
      return self.response(request, cookie: self.cookie(self.oldToken))
    }
    _ = try await restarted.request(input(.refresh, key: anotherKey))
    XCTAssertEqual(store.value?.value, oldToken)
  }

  func testLostResponseReplaysSameKeyAfterRestart() async throws {
    let store = try stored()
    let first = SessionTransport(configuration: try configuration(), store: store) { _ in
      throw SessionFailure.network
    }
    do {
      _ = try await first.request(input(.refresh))
      XCTFail("Expected network error")
    } catch {}
    XCTAssertEqual(store.value?.refreshKey, key)
    let restarted = SessionTransport(configuration: try configuration(), store: store) { request in
      XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), self.key)
      XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "phub_refresh=\(self.oldToken)")
      return self.response(request, cookie: self.cookie(self.nextToken))
    }
    _ = try await restarted.request(input(.refresh, key: anotherKey))
    XCTAssertEqual(store.value?.value, nextToken)
  }

  func testStorageFailureNeverReleasesAccessAndPreservesRecoverableJournal() async throws {
    let store = try stored()
    store.rejectSuccessor = true
    let client = SessionTransport(configuration: try configuration(), store: store) { request in
      self.response(request, cookie: self.cookie(self.nextToken))
    }
    do {
      _ = try await client.request(input(.refresh))
      XCTFail("Expected storage error")
    } catch { XCTAssertEqual(error as? SessionFailure, .storage) }
    XCTAssertEqual(store.value?.value, oldToken)
    XCTAssertEqual(store.value?.refreshKey, key)
    store.rejectSuccessor = false
    _ = try await client.request(input(.refresh, key: anotherKey))
    XCTAssertEqual(store.value?.value, nextToken)
  }

  func testCannotRotateBeforeJournalIsDurable() async throws {
    let store = try stored()
    store.rejectWrites = true
    let client = SessionTransport(configuration: try configuration(), store: store) { _ in
      XCTFail("Do not send before Keychain write succeeds")
      throw SessionFailure.network
    }
    do {
      _ = try await client.request(input(.refresh))
      XCTFail("Expected storage error")
    } catch {}
  }

  func testUnauthorizedClearsButRaceAndServerFailurePreserveCredential() async throws {
    for status in [401, 409, 503] {
      let store = try stored()
      let client = SessionTransport(configuration: try configuration(), store: store) { request in
        self.response(request, status: status, body: "{\"code\":\"test-error\"}")
      }
      let response = try await client.request(input(.refresh))
      XCTAssertEqual(response.status, status)
      XCTAssertEqual(store.value == nil, status == 401)
    }
  }

  func testMissingOrUnsafeCookieAndMalformedSuccessClearSession() async throws {
    let good = cookie(nextToken)
    let cookies: [String?] = [
      nil, good.replacingOccurrences(of: "; Secure", with: ""),
      good.replacingOccurrences(of: "; HttpOnly", with: ""),
      good.replacingOccurrences(of: "SameSite=Lax", with: "SameSite=None"),
      good.replacingOccurrences(of: "local-padel/auth", with: "other/auth"),
      good.replacingOccurrences(of: "Max-Age=3600", with: "Max-Age=0"),
      good + "; Domain=.padlhub.su",
    ]
    for cookie in cookies {
      let store = try stored()
      let client = SessionTransport(configuration: try configuration(), store: store) { request in
        self.response(request, cookie: cookie)
      }
      do {
        _ = try await client.request(input(.refresh))
        XCTFail("Unsafe cookie accepted")
      } catch {}
      XCTAssertNil(store.value)
    }
    let store = try stored()
    let client = SessionTransport(configuration: try configuration(), store: store) { request in
      self.response(request, cookie: good, body: "{\"refreshToken\":\"forbidden\"}")
    }
    do {
      _ = try await client.request(input(.refresh))
      XCTFail("Malformed body accepted")
    } catch {}
    XCTAssertNil(store.value)
  }

  func testRedirectResponseCannotPersistCookies() async throws {
    let store = try stored()
    let client = SessionTransport(configuration: try configuration(), store: store) { request in
      self.response(request, status: 302, cookie: self.cookie(self.nextToken))
    }
    do {
      _ = try await client.request(input(.refresh))
      XCTFail("Redirect accepted")
    } catch { XCTAssertEqual(error as? SessionFailure, .redirect) }
    XCTAssertEqual(store.value?.value, oldToken)
  }

  func testOfflineLogoutIsRetriedBeforeRestorationAfterRestart() async throws {
    let store = try stored()
    let first = SessionTransport(configuration: try configuration(), store: store) { _ in
      throw SessionFailure.network
    }
    do {
      _ = try await first.request(input(.logout))
      XCTFail("Expected network error")
    } catch {}
    XCTAssertEqual(store.value?.logoutKey, key)
    let restarted = SessionTransport(configuration: try configuration(), store: store) { request in
      XCTAssertEqual(request.httpMethod, "DELETE")
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-Session-Intent"), "logout")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), self.key)
      return self.response(request, status: 204, body: "")
    }
    let result = try await restarted.request(input(.refresh, key: anotherKey))
    XCTAssertEqual(result.status, 401)
    XCTAssertNil(store.value)
  }

  func testFailedPendingLogoutNeverPretendsSignedOutOrRestoresAccess() async throws {
    let store = try stored()
    store.value?.logoutKey = key
    let client = SessionTransport(configuration: try configuration(), store: store) { request in
      self.response(request, status: 503, body: "{}")
    }
    let result = try await client.request(input(.refresh))
    XCTAssertEqual(result.status, 503)
    XCTAssertNotNil(store.value?.logoutKey)
  }

  func testLogoutRecoversLostRotationThenRevokesSuccessor() async throws {
    let store = try stored()
    store.value?.refreshKey = key
    var methods: [String] = []
    let client = SessionTransport(configuration: try configuration(), store: store) { request in
      methods.append(request.httpMethod!)
      if request.httpMethod == "POST" {
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), self.key)
        return self.response(request, cookie: self.cookie(self.nextToken))
      }
      XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "phub_refresh=\(self.nextToken)")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), self.anotherKey)
      return self.response(request, status: 204, body: "")
    }
    let response = try await client.request(input(.logout, key: anotherKey))
    XCTAssertEqual(response.status, 204)
    XCTAssertEqual(methods, ["POST", "DELETE"])
    XCTAssertNil(store.value)
  }

  func testConcurrentLogoutWaitsForRotationAndClearsItsSuccessor() async throws {
    let store = try stored()
    var resume: CheckedContinuation<Void, Never>?
    let started = expectation(description: "refresh started")
    let client = SessionTransport(configuration: try configuration(), store: store) { request in
      if request.httpMethod == "POST" {
        await withCheckedContinuation {
          resume = $0
          started.fulfill()
        }
        return self.response(request, cookie: self.cookie(self.nextToken))
      }
      XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "phub_refresh=\(self.nextToken)")
      return self.response(request, status: 204, body: "")
    }
    let refresh = Task { try await client.request(input(.refresh)) }
    await fulfillment(of: [started], timeout: 2)
    let logout = Task { try await client.request(input(.logout, key: anotherKey)) }
    resume?.resume()
    _ = try await refresh.value
    _ = try await logout.value
    XCTAssertNil(store.value)
  }

  func testRealIOSKeychainPersistsAcrossInstancesAndClearsAfterReinstallMarker() throws {
    #if os(iOS)
      guard Bundle.main.bundleIdentifier == "ru.padlhub.app" else {
        throw XCTSkip("Real Keychain requires the App-hosted test target")
      }
      let bundle = "ru.padlhub.tests.\(UUID().uuidString)"
      let defaults = UserDefaults(suiteName: bundle)!
      defer { defaults.removePersistentDomain(forName: bundle) }
      let scope = try configuration().keychainScope
      let store = try KeychainCredentialStore(bundleID: bundle, scope: scope, defaults: defaults)
      defer { try? store.clear() }
      let credential = try stored().value!
      try store.write(credential)
      let reopened = try KeychainCredentialStore(bundleID: bundle, scope: scope, defaults: defaults)
      XCTAssertEqual(try reopened.read(), credential)
      var attributes: CFTypeRef?
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "\(bundle).padlhub-session.\(scope)",
        kSecAttrAccount as String: "phub_refresh",
        kSecReturnAttributes as String: true,
      ]
      XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &attributes), errSecSuccess)
      let dictionary = attributes as! [String: Any]
      XCTAssertEqual(
        dictionary[kSecAttrAccessible as String] as? String,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
      XCTAssertEqual(dictionary[kSecAttrSynchronizable as String] as? Bool, false)
      defaults.removePersistentDomain(forName: bundle)
      let reinstalled = try KeychainCredentialStore(
        bundleID: bundle, scope: scope, defaults: defaults)
      XCTAssertNil(try reinstalled.read())
    #else
      throw XCTSkip("Keychain integration executes on the owned iOS simulator")
    #endif
  }
}
