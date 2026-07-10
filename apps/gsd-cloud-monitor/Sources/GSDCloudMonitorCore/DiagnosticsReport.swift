import Foundation

public struct DiagnosticsReport: Encodable, Sendable {
  private struct Project: Encodable {
    let alias: String
    let state: RuntimeProjectState
    let activeRequests: Int
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
    self.generatedAt = generatedAt
    state = telemetry.state
    gatewayHost = telemetry.gatewayURL.host
    runtimeID = telemetry.runtimeID
    runtimeName = telemetry.runtimeName
    connectionAttempts = telemetry.connectionAttempts
    reconnects = telemetry.reconnects
    receivedMessages = telemetry.receivedMessages
    sentMessages = telemetry.sentMessages
    receivedBytes = telemetry.receivedBytes
    sentBytes = telemetry.sentBytes
    projects = telemetry.projects.map { project in
      Project(
        alias: project.alias,
        state: project.state,
        activeRequests: project.activeRequests,
        requestCount: project.requestCount,
        errorCount: project.errorCount,
        receivedBytes: project.receivedBytes,
        sentBytes: project.sentBytes,
        lastTool: project.lastTool
      )
    }
    recentActivity = telemetry.recentActivity.map { activity in
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
