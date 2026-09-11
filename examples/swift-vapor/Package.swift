// swift-tools-version:6.2
import PackageDescription

let package = Package(
  name: "CormierRealtimeVaporExample",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "CormierRealtimeVaporExample", targets: ["App"])
  ],
  dependencies: [
    .package(url: "https://github.com/swift-server/async-http-client.git", exact: "1.36.1"),
    .package(url: "https://github.com/vapor/vapor.git", exact: "4.121.4"),
    .package(url: "https://github.com/vapor/redis.git", exact: "4.14.0"),
  ],
  targets: [
    .executableTarget(
      name: "App",
      dependencies: [
        .product(name: "AsyncHTTPClient", package: "async-http-client"),
        .product(name: "Vapor", package: "vapor"),
        .product(name: "Redis", package: "redis"),
      ],
      swiftSettings: [.enableUpcomingFeature("ExistentialAny")]
    ),
    .testTarget(name: "AppTests", dependencies: [.target(name: "App")]),
  ]
)
