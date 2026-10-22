import Foundation

public struct NotificationCommand: Sendable {
  public let resource: String
  public let id: String?
  public init(resource: String, id: String? = nil) {
    self.resource = resource
    self.id = id
  }
  var method: String {
    resource == "pushRevoke" ? "DELETE" : resource == "pushRegister" ? "POST" : "PUT"
  }
  func path(configuration: SessionConfiguration) throws -> String {
    let root = "/user/api/v1/\(configuration.tenant)"
    switch resource {
    case "pushRegister":
      guard id == nil else { throw SessionFailure.request }
      return root + "/notification-endpoints/ios"
    case "pushRevoke":
      guard let id, UUID(uuidString: id) != nil else { throw SessionFailure.request }
      return root + "/notification-endpoints/ios/" + id
    case "preferencesUpdate":
      guard id == nil else { throw SessionFailure.request }
      return root + "/notifications/preferences"
    case "readCursor":
      guard id == nil else { throw SessionFailure.request }
      return root + "/notifications/read-cursor"
    default: throw SessionFailure.request
    }
  }
  func validatedBody(_ body: String?) throws -> Data? {
    if resource == "pushRevoke" {
      guard body == nil else { throw SessionFailure.request }
      return nil
    }
    guard let body, let data = body.data(using: .utf8), data.count <= 32768,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw SessionFailure.request }
    switch resource {
    case "pushRegister":
      guard Set(object.keys) == ["installationId", "token"],
        let installation = object["installationId"] as? String,
        UUID(uuidString: installation) != nil, let token = object["token"] as? String,
        token.range(of: "^[a-fA-F0-9]{32,1024}$", options: .regularExpression) != nil,
        token.count % 2 == 0
      else { throw SessionFailure.request }
    case "readCursor":
      guard Set(object.keys) == ["throughId"], let id = object["throughId"] as? String,
        UUID(uuidString: id) != nil
      else { throw SessionFailure.request }
    case "preferencesUpdate":
      guard Set(object.keys) == ["categories"],
        let categories = object["categories"] as? [[String: Any]],
        (1...32).contains(categories.count)
      else { throw SessionFailure.request }
      for category in categories {
        guard Set(category.keys) == ["category", "channels"],
          let name = category["category"] as? String,
          name.range(of: "^[A-Z][A-Z0-9_]{1,63}$", options: .regularExpression) != nil,
          let channels = category["channels"] as? [[String: Any]], (1...3).contains(channels.count)
        else { throw SessionFailure.request }
        for channel in channels {
          guard
            Set(channel.keys).isSubset(of: [
              "channel", "enabled", "quietFrom", "quietUntil", "timezone",
            ]), let name = channel["channel"] as? String,
            ["IN_APP", "PUSH", "EMAIL"].contains(name), channel["enabled"] is Bool
          else { throw SessionFailure.request }
        }
      }
    default: throw SessionFailure.request
    }
    return data
  }
}
