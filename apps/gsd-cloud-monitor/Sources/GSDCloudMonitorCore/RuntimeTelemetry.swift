import Foundation

public enum RuntimeConnectionState: String, Codable, Sendable {
  case connecting
  case connected
  case reconnecting
  case error
  case stopped
  case stale
}

public func telemetryUnavailableState(
  validatedProcessIsRunning: Bool?
) -> RuntimeConnectionState {
  validatedProcessIsRunning == false ? .stopped : .stale
}

public struct TelemetryUnavailableStateTracker: Sendable {
  private var validatedProcessIsRunning: Bool?

  public var connectionState: RuntimeConnectionState {
    telemetryUnavailableState(validatedProcessIsRunning: validatedProcessIsRunning)
  }

  public init() {}

  public mutating func recordProcessValidation(isRunning: Bool?) {
    validatedProcessIsRunning = isRunning
  }

  public mutating func reset() {
    validatedProcessIsRunning = nil
  }
}

public struct TelemetryFreshnessTracker: Sendable {
  private var lastUpdatedAt: Date?
  private var missedObservations = 0

  public init() {}

  public mutating func connectionState(
    reportedState: RuntimeConnectionState,
    updatedAt: Date,
    processIsRunning: Bool,
    now _: Date = Date()
  ) -> RuntimeConnectionState {
    guard processIsRunning else {
      reset()
      return .stopped
    }
    if lastUpdatedAt == updatedAt {
      missedObservations += 1
    } else {
      lastUpdatedAt = updatedAt
      missedObservations = 0
    }
    return missedObservations >= 2 ? .stale : reportedState
  }

  public mutating func reset() {
    lastUpdatedAt = nil
    missedObservations = 0
  }
}

public enum RuntimeProjectState: String, Codable, Sendable {
  case idle
  case active
  case error
}

public enum RuntimeActivityOutcome: String, Codable, Sendable {
  case success
  case error
  case cancelled
}

public struct RuntimeProjectTelemetry: Decodable, Identifiable, Sendable {
  public var id: String { path }

  public let alias: String
  public let path: String
  public let repoIdentity: String
  public let remoteLabel: String?
  public let state: RuntimeProjectState
  public let activeRequests: Int
  public let activeTools: [String]
  public let requestCount: Int
  public let errorCount: Int
  public let receivedBytes: Int64
  public let sentBytes: Int64
  public let lastTool: String?
  public let lastActivityAt: Date?

  private enum CodingKeys: String, CodingKey {
    case alias
    case path
    case repoIdentity = "repo_identity"
    case remoteLabel = "remote_label"
    case state
    case activeRequests = "active_requests"
    case activeTools = "active_tools"
    case requestCount = "request_count"
    case errorCount = "error_count"
    case receivedBytes = "received_bytes"
    case sentBytes = "sent_bytes"
    case lastTool = "last_tool"
    case lastActivityAt = "last_activity_at"
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    alias = try values.decode(String.self, forKey: .alias)
    path = try values.decode(String.self, forKey: .path)
    repoIdentity = try values.decode(String.self, forKey: .repoIdentity)
    remoteLabel = try values.decodeIfPresent(String.self, forKey: .remoteLabel)
    state = try values.decode(RuntimeProjectState.self, forKey: .state)
    activeRequests = try values.decode(Int.self, forKey: .activeRequests)
    activeTools = try values.decodeIfPresent([String].self, forKey: .activeTools) ?? []
    requestCount = try values.decode(Int.self, forKey: .requestCount)
    errorCount = try values.decode(Int.self, forKey: .errorCount)
    receivedBytes = try values.decode(Int64.self, forKey: .receivedBytes)
    sentBytes = try values.decode(Int64.self, forKey: .sentBytes)
    lastTool = try values.decodeIfPresent(String.self, forKey: .lastTool)
    lastActivityAt = try values.decodeIfPresent(Date.self, forKey: .lastActivityAt)
  }
}

public struct RuntimeActivity: Decodable, Identifiable, Sendable {
  public var id: String { requestID }

  public let requestID: String
  public let projectAlias: String?
  public let projectPath: String?
  public let toolName: String
  public let outcome: RuntimeActivityOutcome
  public let durationMs: Int
  public let at: Date
  public let error: String?

  private enum CodingKeys: String, CodingKey {
    case requestID = "request_id"
    case projectAlias = "project_alias"
    case projectPath = "project_path"
    case toolName = "tool_name"
    case outcome
    case durationMs = "duration_ms"
    case at
    case error
  }

  public func belongs(to project: RuntimeProjectTelemetry) -> Bool {
    if let projectPath { return projectPath == project.path }
    return projectAlias == project.alias
  }
}

public struct RuntimeTelemetry: Decodable, Sendable {
  public let version: Int
  public let pid: Int32
  public let state: RuntimeConnectionState
  public let gatewayURL: URL
  public let runtimeID: String?
  public let runtimeName: String?
  public let startedAt: Date
  public let connectedAt: Date?
  public let updatedAt: Date
  public let lastError: String?
  public let connectionAttempts: Int
  public let reconnects: Int
  public let receivedMessages: Int
  public let sentMessages: Int
  public let receivedBytes: Int64
  public let sentBytes: Int64
  public let activeRequests: Int
  public let projects: [RuntimeProjectTelemetry]
  public let recentActivity: [RuntimeActivity]

  private enum CodingKeys: String, CodingKey {
    case version
    case pid
    case state
    case gatewayURL = "gateway_url"
    case runtimeID = "runtime_id"
    case runtimeName = "runtime_name"
    case startedAt = "started_at"
    case connectedAt = "connected_at"
    case updatedAt = "updated_at"
    case lastError = "last_error"
    case connectionAttempts = "connection_attempts"
    case reconnects
    case receivedMessages = "received_messages"
    case sentMessages = "sent_messages"
    case receivedBytes = "received_bytes"
    case sentBytes = "sent_bytes"
    case activeRequests = "active_requests"
    case projects
    case recentActivity = "recent_activity"
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    version = try values.decode(Int.self, forKey: .version)
    pid = try values.decode(Int32.self, forKey: .pid)
    state = try values.decode(RuntimeConnectionState.self, forKey: .state)
    gatewayURL = try values.decode(URL.self, forKey: .gatewayURL)
    runtimeID = try values.decodeIfPresent(String.self, forKey: .runtimeID)
    runtimeName = try values.decodeIfPresent(String.self, forKey: .runtimeName)
    startedAt = try values.decode(Date.self, forKey: .startedAt)
    connectedAt = try values.decodeIfPresent(Date.self, forKey: .connectedAt)
    updatedAt = try values.decode(Date.self, forKey: .updatedAt)
    lastError = try values.decodeIfPresent(String.self, forKey: .lastError)
    connectionAttempts = try values.decode(Int.self, forKey: .connectionAttempts)
    reconnects = try values.decode(Int.self, forKey: .reconnects)
    receivedMessages = try values.decode(Int.self, forKey: .receivedMessages)
    sentMessages = try values.decode(Int.self, forKey: .sentMessages)
    receivedBytes = try values.decode(Int64.self, forKey: .receivedBytes)
    sentBytes = try values.decode(Int64.self, forKey: .sentBytes)
    activeRequests = try values.decode(Int.self, forKey: .activeRequests)
    projects = try values.decodeIfPresent([RuntimeProjectTelemetry].self, forKey: .projects) ?? []
    recentActivity =
      try values.decodeIfPresent([RuntimeActivity].self, forKey: .recentActivity) ?? []
  }
}

public struct TrafficCounters: Equatable, Sendable {
  public let receivedBytes: Int64
  public let sentBytes: Int64

  public init(receivedBytes: Int64, sentBytes: Int64) {
    self.receivedBytes = receivedBytes
    self.sentBytes = sentBytes
  }

  public func rate(since previous: TrafficCounters, elapsed: TimeInterval) -> TrafficRate {
    guard elapsed > 0 else { return .zero }
    let receivedDelta = max(0, receivedBytes - previous.receivedBytes)
    let sentDelta = max(0, sentBytes - previous.sentBytes)
    return TrafficRate(
      receivedBytesPerSecond: Double(receivedDelta) / elapsed,
      sentBytesPerSecond: Double(sentDelta) / elapsed
    )
  }
}

public struct TrafficRate: Equatable, Sendable {
  public let receivedBytesPerSecond: Double
  public let sentBytesPerSecond: Double

  public init(receivedBytesPerSecond: Double, sentBytesPerSecond: Double) {
    self.receivedBytesPerSecond = receivedBytesPerSecond
    self.sentBytesPerSecond = sentBytesPerSecond
  }

  public static let zero = TrafficRate(receivedBytesPerSecond: 0, sentBytesPerSecond: 0)
}

public struct RuntimeTelemetryReader: Sendable {
  public init() {}

  public func load(from fileURL: URL) throws -> RuntimeTelemetry {
    let data = try Data(contentsOf: fileURL)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let value = try container.decode(String.self)
      if let date = Self.fractionalDateFormatter.date(from: value)
        ?? Self.dateFormatter.date(from: value)
      {
        return date
      }
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Invalid ISO-8601 date: \(value)"
      )
    }
    let telemetry = try decoder.decode(RuntimeTelemetry.self, from: data)
    guard telemetry.version == 1 else {
      throw RuntimeTelemetryError.unsupportedVersion(telemetry.version)
    }
    return telemetry
  }

  private static let fractionalDateFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private static let dateFormatter = ISO8601DateFormatter()
}

public enum RuntimeTelemetryError: Error, Equatable {
  case unsupportedVersion(Int)
}

extension RuntimeTelemetry {
  public var trafficCounters: TrafficCounters {
    TrafficCounters(receivedBytes: receivedBytes, sentBytes: sentBytes)
  }
}

extension RuntimeProjectTelemetry {
  public var trafficCounters: TrafficCounters {
    TrafficCounters(receivedBytes: receivedBytes, sentBytes: sentBytes)
  }

  public var activeToolSummary: String {
    activeTools.isEmpty ? "\(activeRequests) active" : activeTools.joined(separator: ", ")
  }
}
