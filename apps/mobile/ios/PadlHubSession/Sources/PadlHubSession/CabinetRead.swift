import Foundation

/// Reviewed first-party reads only. The WebView cannot choose a URL, tenant or HTTP method.
public enum CabinetResource: String, Sendable {
  case home, homeBase, profile, preferences, privacy, bookings, history, recommendations
  case locations, location, game, publicGames, communities

  var isPublic: Bool { self == .publicGames }
}

public struct CabinetRead: Sendable {
  public let resource: CabinetResource
  public let id: String?
  public let query: [String: String]

  public init(resource: CabinetResource, id: String? = nil, query: [String: String] = [:]) {
    self.resource = resource
    self.id = id
    self.query = query
  }

  func url(configuration: SessionConfiguration) throws -> URL {
    let suffix: String
    var allowed: Set<String> = []
    switch resource {
    case .home: suffix = "/home"
    case .homeBase: suffix = "/home/base"
    case .profile: suffix = "/profile"
    case .preferences: suffix = "/profile/booking-preferences"
    case .privacy: suffix = "/profile/privacy"
    case .bookings: suffix = "/bookings/upcoming"
    case .history:
      suffix = "/bookings/history"
      allowed = ["kind", "status", "limit", "cursor"]
    case .recommendations:
      suffix = "/recommendations/bookings"
      allowed = ["limit", "cursor"]
    case .locations: suffix = "/locations"
    case .location, .game:
      guard let id, UUID(uuidString: id) != nil else { throw SessionFailure.request }
      suffix = "/\(resource == .location ? "locations" : "games")/\(id)"
    case .publicGames:
      suffix = "/games"
      allowed = ["stationId", "startsFrom", "startsTo", "kind", "levelFrom", "levelTo", "availability", "limit", "cursor"]
    case .communities:
      suffix = "/communities/mine"
      allowed = ["limit", "cursor"]
    }
    guard (resource == .location || resource == .game) || id == nil,
      Set(query.keys).isSubset(of: allowed)
    else { throw SessionFailure.request }
    for (key, value) in query {
      guard !value.isEmpty, value.utf8.count <= 2048,
        value.rangeOfCharacter(from: .controlCharacters) == nil
      else { throw SessionFailure.request }
      switch key {
      case "limit":
        guard value.range(of: "^[1-9][0-9]?$", options: .regularExpression) != nil,
          let limit = Int(value), limit <= (resource == .recommendations ? 20 : 50)
        else { throw SessionFailure.request }
      case "cursor":
        guard (16...512).contains(value.count) else { throw SessionFailure.request }
      case "stationId":
        guard UUID(uuidString: value) != nil else { throw SessionFailure.request }
      case "startsFrom", "startsTo":
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard parser.date(from: value) != nil || ISO8601DateFormatter().date(from: value) != nil
        else { throw SessionFailure.request }
      case "levelFrom", "levelTo":
        guard ["D", "D+", "C", "C+", "B", "B+", "A"].contains(value)
        else { throw SessionFailure.request }
      case "availability":
        guard ["JOINABLE", "INCLUDE_FULL"].contains(value) else { throw SessionFailure.request }
      case "kind" where resource == .publicGames:
        guard ["FRIENDLY", "RATING", "PRIVATE", "COACH_GAME"].contains(value)
        else { throw SessionFailure.request }
      case "kind":
        guard ["GAME", "TRAINING", "TOURNAMENT"].contains(value) else { throw SessionFailure.request }
      case "status":
        guard ["COMPLETED", "CANCELLED"].contains(value) else { throw SessionFailure.request }
      default:
        guard value.range(of: "^[A-Z_]{1,32}$", options: .regularExpression) != nil
        else { throw SessionFailure.request }
      }
    }
    let prefix = resource.isPublic ? "/public/api/v1/" : "/user/api/v1/"
    guard var url = URLComponents(string: configuration.origin) else { throw SessionFailure.request }
    url.path = prefix + configuration.tenant + suffix
    if !query.isEmpty {
      url.queryItems = query.keys.sorted().map { URLQueryItem(name: $0, value: query[$0]) }
      // Servers decode query strings as form data: a literal '+' must survive as '+'.
      url.percentEncodedQuery = url.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
    }
    guard let result = url.url else { throw SessionFailure.request }
    return result
  }
}
