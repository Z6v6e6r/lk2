import Foundation
import CoreFoundation

/// A closed set of existing conversation commands. No caller-supplied URL or HTTP method.
public struct MessagingCommand: Sendable {
  public let resource: String
  public let id: String?
  public init(resource: String, id: String? = nil) {
    self.resource = resource
    self.id = id
  }
  var isTicket: Bool { resource == "realtimeTicket" }
  var method: String { resource == "sendMessage" || isTicket ? "POST" : "PUT" }

  func path(configuration: SessionConfiguration) throws -> String {
    let root = "/user/api/v1/\(configuration.tenant)"
    if isTicket {
      guard id == nil else { throw SessionFailure.request }
      return root + "/messaging/realtime-ticket"
    }
    guard let id, UUID(uuidString: id) != nil else { throw SessionFailure.request }
    let suffix: String
    switch resource {
    case "sendMessage": suffix = "messages"
    case "messageReadCursor": suffix = "read-cursor"
    case "conversationPolicy": suffix = "notification-policy"
    default: throw SessionFailure.request
    }
    return root + "/conversations/\(id)/\(suffix)"
  }

  func validatedBody(_ body: String?, key: String?) throws -> Data? {
    if isTicket {
      guard body == nil, key == nil else { throw SessionFailure.request }
      return nil
    }
    guard let body, let data = body.data(using: .utf8), data.count <= 65536,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw SessionFailure.request }
    switch resource {
    case "sendMessage":
      guard Set(object.keys) == ["clientMessageId", "body"],
        let clientID = object["clientMessageId"] as? String, clientID == key,
        clientID.range(of: "^[A-Za-z0-9._:-]{16,128}$", options: .regularExpression) != nil,
        let text = object["body"] as? String, text.utf16.count <= 8000,
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else { throw SessionFailure.request }
    case "messageReadCursor":
      guard Set(object.keys) == ["throughSequence"],
        let number = object["throughSequence"] as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID(),
        number.doubleValue >= 0, number.doubleValue <= 9007199254740991,
        number.doubleValue.rounded(.towardZero) == number.doubleValue
      else { throw SessionFailure.request }
    case "conversationPolicy":
      guard Set(object.keys).isSubset(of: ["level", "mutedUntil"]),
        let level = object["level"] as? String, ["ALL", "MENTIONS", "NONE"].contains(level)
      else { throw SessionFailure.request }
      if let until = object["mutedUntil"], !(until is NSNull) {
        guard let value = until as? String else { throw SessionFailure.request }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let instant = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value),
          instant > Date(), instant <= Date().addingTimeInterval(30 * 24 * 60 * 60)
        else { throw SessionFailure.request }
      }
    default: throw SessionFailure.request
    }
    return data
  }
}
