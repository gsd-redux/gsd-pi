import Foundation

public struct RuntimeConfiguration: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public var name: String
  public var telemetryPath: String
  public var agentConfigPath: String
  public var agentExecutablePath: String

  public init(
    id: UUID = UUID(),
    name: String,
    telemetryPath: String,
    agentConfigPath: String,
    agentExecutablePath: String
  ) {
    self.id = id
    self.name = name
    self.telemetryPath = telemetryPath
    self.agentConfigPath = agentConfigPath
    self.agentExecutablePath = agentExecutablePath
  }

  public var telemetryURL: URL {
    URL(fileURLWithPath: NSString(string: telemetryPath).expandingTildeInPath)
  }

  public var configPath: String {
    NSString(string: agentConfigPath).expandingTildeInPath
  }

  public var agentExecutableURL: URL {
    URL(fileURLWithPath: NSString(string: agentExecutablePath).expandingTildeInPath)
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, telemetryPath, agentConfigPath, agentExecutablePath
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(UUID.self, forKey: .id)
    name = try values.decode(String.self, forKey: .name)
    telemetryPath = try values.decode(String.self, forKey: .telemetryPath)
    agentExecutablePath = try values.decode(String.self, forKey: .agentExecutablePath)
    agentConfigPath = try values.decodeIfPresent(String.self, forKey: .agentConfigPath)
      ?? URL(fileURLWithPath: NSString(string: telemetryPath).expandingTildeInPath)
        .deletingLastPathComponent()
        .appendingPathComponent("daemon.yaml").path
  }
}
