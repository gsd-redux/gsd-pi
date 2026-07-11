// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "GSDCloudMonitor",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "GSDCloudMonitor", targets: ["GSDCloudMonitor"])
  ],
  targets: [
    .target(name: "GSDCloudMonitorCore"),
    .executableTarget(
      name: "GSDCloudMonitor",
      dependencies: ["GSDCloudMonitorCore"]
    ),
    .executableTarget(
      name: "GSDCloudMonitorCoreTests",
      dependencies: ["GSDCloudMonitorCore"]
    ),
    .executableTarget(name: "GSDCloudMonitorReleaseTests"),
  ]
)
