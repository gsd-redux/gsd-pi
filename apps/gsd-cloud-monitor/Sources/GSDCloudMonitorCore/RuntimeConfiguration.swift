import Foundation

public struct RuntimeConfiguration: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public var name: String
  public var telemetryPath: String
  public var agentExecutablePath: String

  public init(
    id: UUID = UUID(),
    name: String,
    telemetryPath: String,
    agentExecutablePath: String
  ) {
    self.id = id
    self.name = name
    self.telemetryPath = telemetryPath
    self.agentExecutablePath = agentExecutablePath
  }

  public var telemetryURL: URL {
    URL(fileURLWithPath: NSString(string: telemetryPath).expandingTildeInPath)
  }

  public var configPath: String {
    telemetryURL.deletingLastPathComponent().appendingPathComponent("daemon.yaml").path
  }

  public var agentExecutableURL: URL {
    URL(fileURLWithPath: NSString(string: agentExecutablePath).expandingTildeInPath)
  }
}
