// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PadlHubSession",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "PadlHubSession", targets: ["PadlHubSession"])],
    targets: [
        .target(name: "PadlHubSession"),
        .testTarget(name: "PadlHubSessionTests", dependencies: ["PadlHubSession"])
    ]
)
