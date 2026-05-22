// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "mac-agent",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "mac-agent", targets: ["mac-agent"]),
    ],
    targets: [
        .executableTarget(
            name: "mac-agent",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        ),
    ]
)
