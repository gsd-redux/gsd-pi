import Foundation

public struct DiagnosticsReport: Encodable, Sendable {
  private struct Project: Encodable {
    let alias: String
    let state: RuntimeProjectState
    let activeRequests: Int
    let activeTools: [String]
    let requestCount: Int
    let errorCount: Int
    let receivedBytes: Int64
    let sentBytes: Int64
    let lastTool: String?
  }

  private struct Activity: Encodable {
    let projectAlias: String?
    let toolName: String
    let outcome: RuntimeActivityOutcome
    let durationMs: Int
    let at: Date
  }

  private let generatedAt: Date
  private let state: RuntimeConnectionState
  private let configurationName: String?
  private let configPath: String?
  private let telemetryPath: String?
  private let logPath: String?
  private let telemetryError: String?
  private let gatewayHost: String?
  private let runtimeID: String?
  private let runtimeName: String?
  private let connectionAttempts: Int
  private let reconnects: Int
  private let receivedMessages: Int
  private let sentMessages: Int
  private let receivedBytes: Int64
  private let sentBytes: Int64
  private let projects: [Project]
  private let recentActivity: [Activity]

  public init(telemetry: RuntimeTelemetry, generatedAt: Date = Date()) {
    self.init(
      telemetry: telemetry,
      configuration: nil,
      validatedState: telemetry.state,
      telemetryError: nil,
      generatedAt: generatedAt
    )
  }

  public init(
    telemetry: RuntimeTelemetry?,
    configuration: RuntimeConfiguration,
    validatedState: RuntimeConnectionState,
    telemetryError: String?,
    generatedAt: Date = Date()
  ) {
    self.init(
      telemetry: telemetry,
      configuration: Optional(configuration),
      validatedState: validatedState,
      telemetryError: telemetryError,
      generatedAt: generatedAt
    )
  }

  private init(
    telemetry: RuntimeTelemetry?,
    configuration: RuntimeConfiguration?,
    validatedState: RuntimeConnectionState,
    telemetryError: String?,
    generatedAt: Date
  ) {
    self.generatedAt = generatedAt
    state = validatedState
    configurationName = configuration?.name
    configPath = configuration?.configPath
    telemetryPath = configuration?.telemetryURL.path
    logPath = configuration.map { RuntimeArtifactPaths(configPath: $0.configPath).logPath }
    self.telemetryError = telemetryError
    gatewayHost = telemetry?.gatewayURL.host
    runtimeID = telemetry?.runtimeID
    runtimeName = telemetry?.runtimeName
    connectionAttempts = telemetry?.connectionAttempts ?? 0
    reconnects = telemetry?.reconnects ?? 0
    receivedMessages = telemetry?.receivedMessages ?? 0
    sentMessages = telemetry?.sentMessages ?? 0
    receivedBytes = telemetry?.receivedBytes ?? 0
    sentBytes = telemetry?.sentBytes ?? 0
    projects = (telemetry?.projects ?? []).map { project in
      Project(
        alias: project.alias,
        state: project.state,
        activeRequests: project.activeRequests,
        activeTools: project.activeTools,
        requestCount: project.requestCount,
        errorCount: project.errorCount,
        receivedBytes: project.receivedBytes,
        sentBytes: project.sentBytes,
        lastTool: project.lastTool
      )
    }
    recentActivity = (telemetry?.recentActivity ?? []).map { activity in
      Activity(
        projectAlias: activity.projectAlias,
        toolName: activity.toolName,
        outcome: activity.outcome,
        durationMs: activity.durationMs,
        at: activity.at
      )
    }
  }

  public func jsonData() throws -> Data {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return try encoder.encode(self)
  }
}
