import CryptoKit
import Foundation

public struct RuntimeArtifactPaths: Equatable, Sendable {
  public let telemetryPath: String
  public let logPath: String

  public init(configPath: String) {
    let expandedPath = NSString(string: configPath).expandingTildeInPath
    let configURL = URL(fileURLWithPath: expandedPath)
      .standardizedFileURL
      .resolvingSymlinksInPath()
    let namespace: String
    if configURL.lastPathComponent == "daemon.yaml" {
      namespace = ""
    } else {
      let digest = SHA256.hash(data: Data(configURL.path.utf8))
      namespace = "-" + digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }
    let directory = configURL.deletingLastPathComponent()
    telemetryPath = directory.appendingPathComponent("cloud-runtime\(namespace)-status.json").path
    logPath = directory.appendingPathComponent("cloud-runtime\(namespace).log").path
  }
}

public struct RuntimeConfiguration: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public var name: String
  public var telemetryPath: String
  public var telemetryPathIsDerived: Bool
  public var agentConfigPath: String
  public var agentExecutablePath: String
  var requiresPersistence: Bool

  public init(
    id: UUID = UUID(),
    name: String,
    telemetryPath: String,
    telemetryPathIsDerived: Bool = false,
    agentConfigPath: String,
    agentExecutablePath: String
  ) {
    self.id = id
    self.name = name
    self.telemetryPath = telemetryPath
    self.telemetryPathIsDerived = telemetryPathIsDerived
    self.agentConfigPath = agentConfigPath
    self.agentExecutablePath = agentExecutablePath
    requiresPersistence = false
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

  public mutating func updateTelemetryPath(_ path: String) {
    telemetryPath = path
    telemetryPathIsDerived = false
  }

  public mutating func updateAgentConfigPath(_ path: String) {
    agentConfigPath = path
    if telemetryPathIsDerived {
      telemetryPath = RuntimeArtifactPaths(configPath: path).telemetryPath
    }
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, telemetryPath, telemetryPathIsDerived, agentConfigPath, agentExecutablePath
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(UUID.self, forKey: .id)
    name = try values.decode(String.self, forKey: .name)
    let decodedTelemetryPath = try values.decode(String.self, forKey: .telemetryPath)
    let savedTelemetryPathIsDerived = try values.decodeIfPresent(
      Bool.self,
      forKey: .telemetryPathIsDerived
    )
    agentExecutablePath = try values.decode(String.self, forKey: .agentExecutablePath)
    let savedAgentConfigPath = try values.decodeIfPresent(String.self, forKey: .agentConfigPath)
    requiresPersistence = savedTelemetryPathIsDerived == nil || savedAgentConfigPath == nil
    agentConfigPath =
      savedAgentConfigPath
      ?? URL(fileURLWithPath: NSString(string: decodedTelemetryPath).expandingTildeInPath)
      .deletingLastPathComponent()
      .appendingPathComponent("daemon.yaml").path
    let legacyDerivedPath = URL(
      fileURLWithPath: NSString(string: agentConfigPath).expandingTildeInPath
    )
    .deletingLastPathComponent()
    .appendingPathComponent("cloud-runtime-status.json").path
    let derivedPath = RuntimeArtifactPaths(configPath: agentConfigPath).telemetryPath
    if let savedTelemetryPathIsDerived {
      telemetryPathIsDerived = savedTelemetryPathIsDerived
      telemetryPath = savedTelemetryPathIsDerived ? derivedPath : decodedTelemetryPath
    } else if savedAgentConfigPath == nil {
      telemetryPathIsDerived = true
      telemetryPath = decodedTelemetryPath
    } else if decodedTelemetryPath == legacyDerivedPath,
      !FileManager.default.fileExists(atPath: legacyDerivedPath),
      FileManager.default.fileExists(atPath: derivedPath)
    {
      telemetryPathIsDerived = true
      telemetryPath = derivedPath
      requiresPersistence = true
    } else {
      telemetryPathIsDerived = false
      telemetryPath = decodedTelemetryPath
    }
  }
}

public struct StoredRuntimeConfigurations: Sendable {
  public let configurations: [RuntimeConfiguration]
  public let migratedData: Data?
}

public func decodeStoredRuntimeConfigurations(
  _ data: Data
) throws -> StoredRuntimeConfigurations {
  let configurations = try JSONDecoder().decode([RuntimeConfiguration].self, from: data)
  let migratedData =
    configurations.contains(where: \.requiresPersistence)
    ? try JSONEncoder().encode(configurations)
    : nil
  return StoredRuntimeConfigurations(
    configurations: configurations,
    migratedData: migratedData
  )
}
