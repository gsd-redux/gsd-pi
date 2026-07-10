import Foundation

public enum AgentControlAction: Sendable {
  case start
  case stop
  case reconnect
}

public struct AgentCommandResult: Sendable {
  public let output: String
}

public enum AgentCommandError: Error, LocalizedError {
  case failed(command: String, status: Int32, output: String)

  public var errorDescription: String? {
    switch self {
    case let .failed(command, status, output):
      let detail = output.trimmingCharacters(in: .whitespacesAndNewlines)
      return detail.isEmpty
        ? "\(command) exited with status \(status)"
        : detail
    }
  }
}

public struct AgentCommandRunner: Sendable {
  private let executableURL: URL
  private let configPath: String
  private let environment: [String: String]

  public init(
    executableURL: URL,
    configPath: String,
    environment: [String: String] = [:]
  ) {
    self.executableURL = executableURL
    self.configPath = configPath
    self.environment = environment
  }

  @discardableResult
  public func run(_ action: AgentControlAction) throws -> AgentCommandResult {
    switch action {
    case .start:
      return try execute("connect")
    case .stop:
      return try execute("stop")
    case .reconnect:
      let stopped = try execute("stop")
      let connected = try execute("connect")
      return AgentCommandResult(output: [stopped.output, connected.output].joined())
    }
  }

  private func execute(_ command: String) throws -> AgentCommandResult {
    let pipe = Pipe()
    let process = Process()
    process.executableURL = executableURL
    process.arguments = [command, "--config", configPath]
    process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, override in override }
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    process.waitUntilExit()
    let output = String(
      decoding: pipe.fileHandleForReading.readDataToEndOfFile(),
      as: UTF8.self
    )
    guard process.terminationStatus == 0 else {
      throw AgentCommandError.failed(
        command: command,
        status: process.terminationStatus,
        output: output
      )
    }
    return AgentCommandResult(output: output)
  }
}
