#if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST
import Capacitor
import UIKit
import WebKit
import XCTest
@testable import App
@testable import PadlHubSession

final class PadlHubDirectIntegrationTests: XCTestCase {
  @MainActor
  private func wait(_ web: WKWebView, _ condition: String, timeout: TimeInterval = 12) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if (try? await web.evaluateJavaScript("Boolean(" + condition + ")")) as? Bool == true { return }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTFail("Synthetic native UI did not reach: " + condition)
    throw NSError(domain: "B07NativeAcceptance", code: 1)
  }

  @MainActor
  private func run(_ web: WKWebView, _ source: String) async throws {
    _ = try await web.evaluateJavaScript("(() => { " + source + "; return true; })()")
  }

  @MainActor
  private func navigate(_ web: WKWebView, _ route: String) async throws {
    let encoded = String(data: try JSONSerialization.data(withJSONObject: [route]), encoding: .utf8)!
    try await run(web, "history.pushState(null, '', " + encoded + "[0]); window.dispatchEvent(new PopStateEvent('popstate'))")
  }

  @MainActor
  private func input(_ web: WKWebView, _ selector: String, _ value: String) async throws {
    try await wait(web, "document.querySelector('\(selector)')")
    try await run(web, "const field = document.querySelector('\(selector)'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '\(value)'); field.dispatchEvent(new Event('input', {bubbles: true}))")
  }

  @MainActor
  private func attach(_ web: WKWebView, _ name: String) async throws {
    let image = try await web.takeSnapshot(configuration: nil)
    let attachment = XCTAttachment(image: image)
    attachment.name = "synthetic-b07-" + name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor
  private func start(_ fixture: DirectIntegrationFixture) async throws -> WKWebView {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    let controller = try XCTUnwrap(windows.compactMap { $0.rootViewController as? PadlHubBridgeViewController }.first)
    let web = try XCTUnwrap(controller.webView)
    let deadline = Date().addingTimeInterval(10)
    while !controller.directIntegrationEgressReady && Date() < deadline {
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTAssertTrue(controller.directIntegrationEgressReady, "No web load is allowed without the egress gate")
    let plugin = try XCTUnwrap(controller.bridge?.plugin(withName: "PadlHubSession") as? PadlHubSessionPlugin)
    XCTAssertEqual(Set(plugin.pluginMethods.map(\.name)), ["configuration", "request"])
    // Clear the previous document's timers before replacing its synthetic transport.
    web.loadHTMLString("<html><body>B07 fixture reset</body></html>", baseURL: nil)
    try await wait(web, "document.body?.textContent === 'B07 fixture reset'")
    let configuration = try fixture.configuration()
    plugin.installDirectIntegrationTransport(try fixture.transport(), configuration: configuration)
    controller.loadWebView()
    try await wait(web, "document.querySelector('#ios-phone')")
    try await input(web, "#ios-phone", "+79990000000")
    try await run(web, "for (const box of document.querySelectorAll('input[type=checkbox]')) if (!box.checked) box.click()")
    try await wait(web, "document.querySelector('button[type=submit]')?.disabled === false")
    try await run(web, "document.querySelector('button[type=submit]').click()")
    try await input(web, "#ios-code", "1234")
    try await wait(web, "document.querySelector('button[type=submit]')?.disabled === false")
    try await run(web, "document.querySelector('button[type=submit]').click()")
    try await wait(web, "document.querySelector('a[href=\"/games\"]')")
    XCTAssertNotNil(try fixture.store.read(), "Actual native verify must retain the synthetic credential")
    XCTAssertTrue(fixture.snapshot().requests.contains("POST " + DirectIntegrationFixture.root + "/auth/challenges/" + fixture.viewerID + "/verify"))
    return web
  }

  @MainActor
  private func openProfile(_ web: WKWebView, _ fixture: DirectIntegrationFixture) async throws {
    try await run(web, "document.querySelector('a[href=\"/games\"]').click()")
    let selector = "a[href=\"/profile/\(fixture.peerID)\"]"
    try await wait(web, "document.querySelector('\(selector)')")
    try await run(web, "document.querySelector('\(selector)').click()")
    try await wait(web, "location.pathname === '/profile/\(fixture.peerID)' && document.querySelector('a[href^=\"/chats/new?\"]')")
  }

  @MainActor
  private func openDirect(_ web: WKWebView, _ fixture: DirectIntegrationFixture) async throws {
    let selector = "a[href=\"/chats/new?recipientUserId=\(fixture.peerID)&open=1\"]"
    try await wait(web, "document.querySelector('\(selector)')")
    try await run(web, "document.querySelector('\(selector)').click()")
  }

  @MainActor
  private func retry(_ web: WKWebView) async throws {
    try await wait(web, "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Повторить' && !b.disabled)")
    try await run(web, "const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Повторить'); button.focus(); button.click()")
  }

  @MainActor
  func testLostResponseReconcilesThroughNativeBridgeWithoutSecondCreate() async throws {
    let fixture = try DirectIntegrationFixture(mode: .lostResponse)
    let web = try await start(fixture)
    try await openProfile(web, fixture)
    try await attach(web, "profile")
    try await openDirect(web, fixture)
    try await wait(web, "document.querySelector('[role=alert]')")
    XCTAssertEqual(fixture.snapshot().createKeys.count, 1)
    try await attach(web, "lost-response")
    try await retry(web)
    try await wait(web, "location.pathname === '/chats/\(fixture.directID)' && document.querySelector('textarea')")
    try await attach(web, "thread")
    XCTAssertEqual(fixture.snapshot().createKeys.count, 1)
    XCTAssertTrue(fixture.snapshot().requests.contains("GET " + DirectIntegrationFixture.root + "/conversations"))
    XCTAssertEqual(fixture.snapshot().unexpected, [])
  }

  @MainActor
  func testOfflineManualRetryReusesKeyAfterNativeHTTPReconciliation() async throws {
    let fixture = try DirectIntegrationFixture(mode: .offline)
    let web = try await start(fixture)
    try await openProfile(web, fixture)
    try await openDirect(web, fixture)
    try await wait(web, "document.querySelector('[role=alert]')")
    try await Task.sleep(nanoseconds: 250_000_000)
    XCTAssertEqual(fixture.snapshot().createKeys.count, 1, "No automatic command resend")
    try await retry(web)
    try await wait(web, "location.pathname === '/chats/\(fixture.directID)' && document.querySelector('textarea')")
    let snapshot = fixture.snapshot()
    XCTAssertEqual(snapshot.createKeys.count, 2)
    XCTAssertEqual(Set(snapshot.createKeys).count, 1)
    let creates = snapshot.requests.indices.filter { snapshot.requests[$0] == "POST " + DirectIntegrationFixture.root + "/conversations/direct" }
    XCTAssertEqual(creates.count, 2)
    if creates.count == 2 {
      XCTAssertTrue(snapshot.requests[(creates[0] + 1)..<creates[1]].contains("GET " + DirectIntegrationFixture.root + "/conversations"))
    }
    XCTAssertEqual(snapshot.unexpected, [])
  }

  @MainActor
  func testLockedAndMismatchedServerCapabilitiesCannotCreate() async throws {
    for mode in [DirectIntegrationFixture.Mode.locked, .wrongTarget] {
      let fixture = try DirectIntegrationFixture(mode: mode)
      let web = try await start(fixture)
      try await navigate(web, "/chats/new?recipientUserId=" + fixture.peerID + "&open=1")
      try await wait(web, "document.querySelector('[role=alert]')")
      XCTAssertEqual(fixture.snapshot().createKeys.count, 0)
      XCTAssertEqual(fixture.snapshot().unexpected, [])
      let canRetry = try await web.evaluateJavaScript("Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Повторить')") as? Bool
      XCTAssertEqual(canRetry, false)
    }
  }

  @MainActor
  func testLogoutClearsCredentialAndLateProfileCannotRestorePrivateUI() async throws {
    let fixture = try DirectIntegrationFixture(mode: .delayedProfile)
    defer { fixture.releaseProfile() }
    let web = try await start(fixture)
    try await navigate(web, "/profile/" + fixture.peerID)
    let deadline = Date().addingTimeInterval(5)
    while !fixture.snapshot().requests.contains("GET " + DirectIntegrationFixture.root + "/profiles/" + fixture.peerID) && Date() < deadline {
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    XCTAssertTrue(fixture.snapshot().requests.contains("GET " + DirectIntegrationFixture.root + "/profiles/" + fixture.peerID))
    try await navigate(web, "/profile")
    try await wait(web, "Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Выйти'))")
    try await run(web, "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Выйти')).click()")
    let journalDeadline = Date().addingTimeInterval(5)
    while try fixture.store.read()?.logoutKey == nil && Date() < journalDeadline {
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    XCTAssertNotNil(try fixture.store.read()?.logoutKey, "Logout must be journaled while the profile is still held")
    XCTAssertEqual(fixture.snapshot().completedProfiles, 0)
    fixture.releaseProfile()
    try await wait(web, "document.querySelector('#ios-phone')")
    XCTAssertEqual(fixture.snapshot().completedProfiles, 1, "Observe the actual late completion before reload")
    XCTAssertNil(try fixture.store.read())
    XCTAssertTrue(fixture.snapshot().requests.contains("DELETE " + DirectIntegrationFixture.root + "/auth/session"))
    XCTAssertEqual(fixture.snapshot().createKeys.count, 0)
    XCTAssertEqual(fixture.snapshot().unexpected, [])
    // Let the native promise callbacks and React updates settle in the current document.
    _ = try await web.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true", arguments: [:], in: nil, contentWorld: .page)
    let hasPeer = try await web.evaluateJavaScript("document.body.innerText.includes('Борис Тестовый')") as? Bool
    XCTAssertEqual(hasPeer, false)
    web.reload()
    try await wait(web, "document.querySelector('#ios-phone')")
    XCTAssertNil(try fixture.store.read())
    try await attach(web, "logout")
  }

  @MainActor
  func testBrowserEgressAndUnknownNativeCommandStayDenied() async throws {
    let fixture = try DirectIntegrationFixture(mode: .success)
    let web = try await start(fixture)
    let result = try await web.callAsyncJavaScript("""
      const output = [];
      for (const scheme of ['http', 'https']) {
        try { await fetch(scheme + '://127.0.0.1:9/b07-denied'); output.push('unexpected'); }
        catch { output.push('blocked'); }
      }
      for (const scheme of ['ws', 'wss']) {
        try { new WebSocket(scheme + '://127.0.0.1:9/b07-denied'); output.push('unexpected'); }
        catch (e) { output.push(e.message); }
      }
      return output;
      """, arguments: [:], in: nil, contentWorld: .page) as? [String]
    XCTAssertEqual(result, ["blocked", "blocked", "B07_TEST_EGRESS_DENIED", "B07_TEST_EGRESS_DENIED"])
    let before = fixture.snapshot().createKeys.count
    let rejected = try await web.callAsyncJavaScript("""
      const plugin = window.Capacitor?.Plugins?.PadlHubSession;
      if (typeof plugin?.request !== 'function') return false;
      try {
        await plugin.request({operation: 'messaging', resource: 'createDirect', headers: {Authorization: 'Bearer synthetic-short-lived-access', 'Idempotency-Key': 'synthetic-negative-key'}, body: JSON.stringify({otherUserId: 'invalid'})});
        return false;
      } catch (error) { return error.code === 'NATIVE_REQUEST_REJECTED'; }
      """, arguments: [:], in: nil, contentWorld: .page) as? Bool
    XCTAssertEqual(rejected, true)
    XCTAssertEqual(fixture.snapshot().createKeys.count, before, "Invalid command must fail in Swift before fixture transport")
    XCTAssertEqual(fixture.snapshot().unexpected, [])
  }
}
#endif
