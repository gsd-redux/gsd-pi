import Foundation

@main
struct ReleasePackageTests {
  static func main() throws {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let output = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsd-cloud-monitor-release-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: output) }
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let sentinel = output.appendingPathComponent("keep-me.txt")
    try Data("preserve".utf8).write(to: sentinel)

    try run(
      "/bin/bash",
      [
        packageRoot.appendingPathComponent("script/package_release.sh").path,
        "--dry-run",
        "--version", "0.1.0",
        "--output", output.path,
      ]
    )
    try expect(
      FileManager.default.fileExists(atPath: sentinel.path),
      "release packaging must preserve unrelated output files"
    )
    try run(
      "/bin/bash",
      [packageRoot.appendingPathComponent("script/build_and_run.sh").path, "stage"]
    )

    let zip = output.appendingPathComponent("GSDCloudMonitor-0.1.0-macos.zip")
    let dmg = output.appendingPathComponent("GSDCloudMonitor-0.1.0-macos.dmg")
    try expect(FileManager.default.fileExists(atPath: zip.path), "release ZIP is missing")
    try expect(FileManager.default.fileExists(atPath: dmg.path), "release DMG is missing")
    try run("/usr/bin/shasum", ["-a", "256", "-c", "SHA256SUMS"], cwd: output)
    try run("/usr/bin/hdiutil", ["verify", dmg.path])

    let unpacked = output.appendingPathComponent("unpacked")
    try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: true)
    try run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path])
    let app = unpacked.appendingPathComponent("GSDCloudMonitor.app")
    let developmentApp = packageRoot.appendingPathComponent("dist/GSDCloudMonitor.app")
    try expect(
      FileManager.default.fileExists(atPath: developmentApp.path),
      "development app bundle was not staged"
    )
    let executable = app.appendingPathComponent("Contents/MacOS/GSDCloudMonitor")
    let architectures = try outputOf("/usr/bin/lipo", ["-archs", executable.path])
    try expect(architectures.contains("arm64"), "release is missing arm64")
    try expect(architectures.contains("x86_64"), "release is missing x86_64")
    let infoPlist = app.appendingPathComponent("Contents/Info.plist")
    let version = try outputOf(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", infoPlist.path]
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    try expect(version == "0.1.0", "bundle version is incorrect")
    let iconName = try outputOf(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIconFile", infoPlist.path]
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    try expect(iconName == "GSDCloudMonitor", "bundle icon name is incorrect")
    let developmentDisplayName = try outputOf(
      "/usr/libexec/PlistBuddy",
      [
        "-c", "Print :CFBundleDisplayName",
        developmentApp.appendingPathComponent("Contents/Info.plist").path,
      ]
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    try expect(
      developmentDisplayName == "GSD Cloud Monitor",
      "development and release staging metadata must match"
    )
    try expect(
      FileManager.default.fileExists(
        atPath: app.appendingPathComponent("Contents/Resources/GSDCloudMonitor.icns").path
      ),
      "bundle icon resource is missing"
    )
    let entitlements = try outputOf(
      "/usr/bin/codesign",
      ["-d", "--entitlements", ":-", app.path]
    )
    try expect(
      !entitlements.contains("com.apple.security.get-task-allow"),
      "release must not contain the debug get-task-allow entitlement"
    )
    try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    print("GSDCloudMonitorReleaseTests passed")
  }

  static func run(_ executable: String, _ arguments: [String], cwd: URL? = nil) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.currentDirectoryURL = cwd
    process.standardOutput = FileHandle.standardOutput
    process.standardError = FileHandle.standardError
    try process.run()
    process.waitUntilExit()
    try expect(process.terminationStatus == 0, "\(executable) exited \(process.terminationStatus)")
  }

  static func outputOf(_ executable: String, _ arguments: [String]) throws -> String {
    let pipe = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    process.waitUntilExit()
    try expect(process.terminationStatus == 0, "\(executable) exited \(process.terminationStatus)")
    return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  }

  static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw TestFailure(message: message) }
  }
}

struct TestFailure: Error, CustomStringConvertible {
  let message: String
  var description: String { message }
}
