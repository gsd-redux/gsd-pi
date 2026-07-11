import Foundation

public enum AgentControlAction: Sendable {
  case start
  case stop
  case reconnect
}

public func isAgentActionEnabled(
  _ action: AgentControlAction,
  connectionState: RuntimeConnectionState,
  actionInProgress: Bool
) -> Bool {
  guard !actionInProgress else { return false }
  switch action {
  case .start:
    return connectionState != .connected
  case .stop, .reconnect:
    return true
  }
}

public struct AgentCommandResult: Sendable {
  public let output: String
}

public enum AgentCommandError: Error, LocalizedError {
  case failed(command: String, status: Int32, output: String)

  public var errorDescription: String? {
    switch self {
    case .failed(let command, let status, let output):
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

  public func runtimeIsRunning() throws -> Bool {
    let result = try execute("status")
    return try JSONDecoder().decode(AgentRuntimeStatus.self, from: Data(result.output.utf8))
      .background.running
  }

  private func execute(_ command: String) throws -> AgentCommandResult {
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    let process = Process()
    process.executableURL = executableURL
    process.arguments = [command, "--config", configPath]
    process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, override in
      override
    }
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    try process.run()
    var stdoutData = Data()
    var stderrData = Data()
    let readGroup = DispatchGroup()
    readGroup.enter()
    DispatchQueue.global(qos: .utility).async {
      stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
      readGroup.leave()
    }
    readGroup.enter()
    DispatchQueue.global(qos: .utility).async {
      stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
      readGroup.leave()
    }
    readGroup.wait()
    let stdout = String(decoding: stdoutData, as: UTF8.self)
    let stderr = String(decoding: stderrData, as: UTF8.self)
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      let combined = [stdout, stderr]
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
      throw AgentCommandError.failed(
        command: command,
        status: process.terminationStatus,
        output: combined
      )
    }
    return AgentCommandResult(output: stdout)
  }
}

private struct AgentRuntimeStatus: Decodable {
  let background: Background

  struct Background: Decodable {
    let running: Bool
  }
}
