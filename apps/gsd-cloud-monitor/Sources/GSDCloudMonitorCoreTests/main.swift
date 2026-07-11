import Foundation
import GSDCloudMonitorCore

@main
struct RuntimeTelemetryTests {
  static func main() async throws {
    try readerLoadsAgentConnectionAndTrafficState()
    try readerLoadsPerProjectTrafficAndRecentActivity()
    try duplicateAliasesKeepDistinctActivityAndProjectIdentity()
    try trafficRateUsesOnlyGrowthBetweenSamples()
    try trafficRateDoesNotGoNegativeAfterAgentRestart()
    try trafficSeriesCalculatesAndBoundsSamples()
    try trafficSeriesResetsWhenTelemetrySourceChanges()
    try agentCommandsExecuteWithTheSelectedConfiguration()
    try agentCommandsDrainLargeOutputWhileRunning()
    try agentCommandsReportValidatedRuntimeStatus()
    try agentCommandsIgnoreStderrNoiseWhenReportingRuntimeStatus()
    try agentCommandsIncludeStderrInFailureDiagnostics()
    try stopRemainsAvailableWithoutTelemetry()
    try telemetryReadFailuresRemainUnavailableUntilStatusConfirmsStop()
    try validatedOfflineStateSurvivesTelemetryFailures()
    try staleTelemetryRequiresTwoObservedMissedPollsAndSurvivesWake()
    try connectionTransitionsIdentifyNotifications()
    try telemetryAvailabilityTransitionsRequireSuccessfulDecode()
    try runtimeConfigurationsRoundTrip()
    try runtimeConfigurationsPreserveCustomAgentConfigPath()
    try runtimeConfigurationEditsPreservePathProvenance()
    try legacyRuntimeConfigurationsInferTheDefaultAgentConfigPath()
    try savedRuntimeConfigurationsMigrateFormerlyDerivedTelemetryPaths()
    try migratedRuntimeConfigurationsRequestPersistenceOnce()
    try runtimeConfigurationsDeriveDistinctArtifactsInOneDirectory()
    try diagnosticsRedactLocalPaths()
    try diagnosticsRemainAvailableWithoutTelemetry()
    try releaseVersionsCompareMonitorTags()
    try updateCheckStatesExposeVisibleFeedback()
    try await updateCheckerSearchesAllReleasePages()
    print("GSDCloudMonitorCoreTests passed")
  }

  static func readerLoadsPerProjectTrafficAndRecentActivity() throws {
    let fileURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("json")
    let json = """
      {
        "version": 1,
        "pid": 4242,
        "state": "connected",
        "gateway_url": "https://cloud.opengsd.net",
        "started_at": "2026-07-10T12:00:00.000Z",
        "connected_at": "2026-07-10T12:00:01.000Z",
        "updated_at": "2026-07-10T12:00:02.000Z",
        "last_error": null,
        "connection_attempts": 1,
        "reconnects": 0,
        "received_messages": 12,
        "sent_messages": 9,
        "received_bytes": 4096,
        "sent_bytes": 2048,
        "active_requests": 1,
        "projects": [
          {
            "alias": "project-one",
            "path": "/work/project-one",
            "repo_identity": "repo-one",
            "remote_label": "open-gsd/project-one",
            "state": "active",
            "active_requests": 1,
            "active_tools": ["gsd_execute", "gsd_status"],
            "request_count": 7,
            "error_count": 1,
            "received_bytes": 1024,
            "sent_bytes": 512,
            "last_tool": "gsd_execute",
            "last_activity_at": "2026-07-10T12:00:02.000Z"
          }
        ],
        "recent_activity": [
          {
            "request_id": "request-1",
            "project_alias": "project-one",
            "tool_name": "gsd_execute",
            "outcome": "error",
            "duration_ms": 42,
            "at": "2026-07-10T12:00:02.000Z",
            "error": "fixture failure"
          }
        ]
      }
      """
    try Data(json.utf8).write(to: fileURL)
    defer { try? FileManager.default.removeItem(at: fileURL) }

    let status = try RuntimeTelemetryReader().load(from: fileURL)

    try expect(status.projects.count == 1, "expected one project")
    try expect(status.projects[0].alias == "project-one", "expected project alias")
    try expect(status.projects[0].state == .active, "expected active project")
    try expect(
      status.projects[0].activeTools == ["gsd_execute", "gsd_status"],
      "expected all concurrent active tools"
    )
    try expect(
      status.projects[0].activeToolSummary == "gsd_execute, gsd_status",
      "active tool presentation should name concurrent calls"
    )
    try expect(status.projects[0].requestCount == 7, "expected project requests")
    try expect(status.projects[0].errorCount == 1, "expected project errors")
    try expect(status.projects[0].receivedBytes == 1024, "expected project received bytes")
    try expect(status.recentActivity.count == 1, "expected recent activity")
    try expect(status.recentActivity[0].outcome == .error, "expected activity failure")
    try expect(status.recentActivity[0].durationMs == 42, "expected activity duration")
    try expect(status.recentActivity[0].error == "fixture failure", "expected activity error")
  }

  static func readerLoadsAgentConnectionAndTrafficState() throws {
    let fileURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("json")
    let json = """
      {
        "version": 1,
        "pid": 4242,
        "state": "connected",
        "gateway_url": "https://cloud.opengsd.net",
        "runtime_id": "runtime-1",
        "runtime_name": "Studio Mac",
        "started_at": "2026-07-10T12:00:00.000Z",
        "connected_at": "2026-07-10T12:00:01.000Z",
        "updated_at": "2026-07-10T12:00:02.000Z",
        "last_error": null,
        "connection_attempts": 1,
        "reconnects": 0,
        "received_messages": 12,
        "sent_messages": 9,
        "received_bytes": 4096,
        "sent_bytes": 2048,
        "active_requests": 2
      }
      """
    try Data(json.utf8).write(to: fileURL)
    defer { try? FileManager.default.removeItem(at: fileURL) }

    let status = try RuntimeTelemetryReader().load(from: fileURL)

    try expect(status.state == .connected, "expected connected state")
    try expect(status.pid == 4242, "expected agent PID")
    try expect(status.gatewayURL.host == "cloud.opengsd.net", "expected gateway host")
    try expect(status.runtimeName == "Studio Mac", "expected runtime name")
    try expect(status.receivedMessages == 12, "expected received message count")
    try expect(status.sentMessages == 9, "expected sent message count")
    try expect(status.receivedBytes == 4096, "expected received byte count")
    try expect(status.sentBytes == 2048, "expected sent byte count")
    try expect(status.activeRequests == 2, "expected active request count")
    try expect(status.projects.isEmpty, "legacy telemetry should default to no projects")
    try expect(status.recentActivity.isEmpty, "legacy telemetry should default to no activity")
  }

  static func duplicateAliasesKeepDistinctActivityAndProjectIdentity() throws {
    let fileURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("json")
    let json = """
      {
        "version": 1,
        "pid": 4242,
        "state": "connected",
        "gateway_url": "https://cloud.opengsd.net",
        "started_at": "2026-07-10T12:00:00.000Z",
        "connected_at": "2026-07-10T12:00:01.000Z",
        "updated_at": "2026-07-10T12:00:02.000Z",
        "last_error": null,
        "connection_attempts": 1,
        "reconnects": 0,
        "received_messages": 2,
        "sent_messages": 2,
        "received_bytes": 20,
        "sent_bytes": 20,
        "active_requests": 0,
        "projects": [
          {"alias":"app","path":"/work/one/app","repo_identity":"shared","state":"idle","active_requests":0,"request_count":1,"error_count":0,"received_bytes":10,"sent_bytes":10,"last_tool":"gsd_status","last_activity_at":null},
          {"alias":"app","path":"/work/two/app","repo_identity":"shared","state":"idle","active_requests":0,"request_count":1,"error_count":0,"received_bytes":10,"sent_bytes":10,"last_tool":"gsd_status","last_activity_at":null}
        ],
        "recent_activity": [
          {"request_id":"one","project_alias":"app","project_path":"/work/one/app","tool_name":"gsd_status","outcome":"success","duration_ms":1,"at":"2026-07-10T12:00:02.000Z"},
          {"request_id":"two","project_alias":"app","project_path":"/work/two/app","tool_name":"gsd_status","outcome":"success","duration_ms":1,"at":"2026-07-10T12:00:02.000Z"}
        ]
      }
      """
    try Data(json.utf8).write(to: fileURL)
    defer { try? FileManager.default.removeItem(at: fileURL) }

    let status = try RuntimeTelemetryReader().load(from: fileURL)
    try expect(status.projects[0].id != status.projects[1].id, "project IDs must be path-unique")
    try expect(
      status.recentActivity.filter { $0.belongs(to: status.projects[1]) }.map(\.requestID) == [
        "two"
      ],
      "activity must match the selected project path"
    )
  }

  static func trafficRateUsesOnlyGrowthBetweenSamples() throws {
    let previous = TrafficCounters(receivedBytes: 1_000, sentBytes: 500)
    let current = TrafficCounters(receivedBytes: 1_600, sentBytes: 800)

    let rate = current.rate(since: previous, elapsed: 2)

    try expect(rate.receivedBytesPerSecond == 300, "expected received byte rate")
    try expect(rate.sentBytesPerSecond == 150, "expected sent byte rate")
  }

  static func trafficRateDoesNotGoNegativeAfterAgentRestart() throws {
    let previous = TrafficCounters(receivedBytes: 1_000, sentBytes: 500)
    let restarted = TrafficCounters(receivedBytes: 10, sentBytes: 5)

    let rate = restarted.rate(since: previous, elapsed: 1)

    try expect(rate.receivedBytesPerSecond == 0, "received byte rate must reset to zero")
    try expect(rate.sentBytesPerSecond == 0, "sent byte rate must reset to zero")
  }

  static func trafficSeriesCalculatesAndBoundsSamples() throws {
    var series = TrafficSeries(limit: 2)
    let startedAt = Date(timeIntervalSince1970: 1_000)

    series.record(
      counters: TrafficCounters(receivedBytes: 100, sentBytes: 50),
      at: startedAt
    )
    series.record(
      counters: TrafficCounters(receivedBytes: 500, sentBytes: 250),
      at: startedAt.addingTimeInterval(2)
    )
    series.record(
      counters: TrafficCounters(receivedBytes: 700, sentBytes: 350),
      at: startedAt.addingTimeInterval(4)
    )

    try expect(series.samples.count == 2, "traffic history should honor its limit")
    try expect(
      series.samples[0].receivedBytesPerSecond == 200, "expected first retained receive rate")
    try expect(series.samples[0].sentBytesPerSecond == 100, "expected first retained send rate")
    try expect(series.samples[1].receivedBytesPerSecond == 100, "expected latest receive rate")
    try expect(series.samples[1].sentBytesPerSecond == 50, "expected latest send rate")
  }

  static func trafficSeriesResetsWhenTelemetrySourceChanges() throws {
    var series = TrafficSeries(limit: 60)
    let startedAt = Date(timeIntervalSince1970: 1_000)

    series.record(
      counters: TrafficCounters(receivedBytes: 100, sentBytes: 50),
      sourceID: "/runtime/one/status.json",
      at: startedAt
    )
    series.record(
      counters: TrafficCounters(receivedBytes: 500, sentBytes: 250),
      sourceID: "/runtime/one/status.json",
      at: startedAt.addingTimeInterval(1)
    )
    series.record(
      counters: TrafficCounters(receivedBytes: 10_000, sentBytes: 8_000),
      sourceID: "/runtime/two/status.json",
      at: startedAt.addingTimeInterval(2)
    )

    try expect(series.samples.count == 1, "a new telemetry source must reset traffic history")
    try expect(
      series.samples[0].receivedBytesPerSecond == 0, "a new source must start at zero rate")
    try expect(series.samples[0].sentBytesPerSecond == 0, "a new source must start at zero rate")
  }

  static func agentCommandsExecuteWithTheSelectedConfiguration() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsd-cloud-command-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = root.appendingPathComponent("gsd-cloud-fixture.sh")
    let invocations = root.appendingPathComponent("invocations.txt")
    let script = "#!/bin/bash\necho \"$*\" >>\"$GSD_TEST_INVOCATIONS\"\n"
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: executable.path
    )
    let runner = AgentCommandRunner(
      executableURL: executable,
      configPath: "/work/custom-runtime.yaml",
      environment: ["GSD_TEST_INVOCATIONS": invocations.path]
    )

    try runner.run(.stop)
    try runner.run(.reconnect)

    let lines = try String(contentsOf: invocations, encoding: .utf8)
      .split(separator: "\n")
      .map(String.init)
    try expect(
      lines == [
        "stop --config /work/custom-runtime.yaml",
        "stop --config /work/custom-runtime.yaml",
        "connect --config /work/custom-runtime.yaml",
      ], "agent command sequence is incorrect")
  }

  static func agentCommandsDrainLargeOutputWhileRunning() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsd-cloud-command-output-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = root.appendingPathComponent("gsd-cloud-large-output.sh")
    let script = "#!/bin/bash\n/usr/bin/head -c 1048576 /dev/zero | /usr/bin/tr '\\0' x\n"
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: executable.path
    )

    let result = try AgentCommandRunner(
      executableURL: executable,
      configPath: "/work/runtime.yaml"
    ).run(.start)

    try expect(result.output.utf8.count == 1_048_576, "runner must drain all command output")
  }

  static func agentCommandsReportValidatedRuntimeStatus() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsd-cloud-status-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = root.appendingPathComponent("gsd-cloud-status.sh")
    let script = """
      #!/bin/bash
      if [[ "$1" == "status" ]]; then
        echo '{"background":{"running":true}}'
      fi
      """
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: executable.path
    )

    let running = try AgentCommandRunner(
      executableURL: executable,
      configPath: "/work/runtime.yaml"
    ).runtimeIsRunning()

    try expect(running, "validated CLI status should report the runtime as running")
  }

  static func agentCommandsIgnoreStderrNoiseWhenReportingRuntimeStatus() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsd-cloud-status-stderr-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = root.appendingPathComponent("gsd-cloud-status-noisy.sh")
    let script = """
      #!/bin/bash
      echo "(node:1234) DeprecationWarning: noisy warning" >&2
      if [[ "$1" == "status" ]]; then
        echo '{"background":{"running":true}}'
      fi
      """
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: executable.path
    )

    let running = try AgentCommandRunner(
      executableURL: executable,
      configPath: "/work/runtime.yaml"
    ).runtimeIsRunning()

    try expect(running, "stderr noise must not corrupt the stdout status decode")
  }

  static func agentCommandsIncludeStderrInFailureDiagnostics() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsd-cloud-failure-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = root.appendingPathComponent("gsd-cloud-failing.sh")
    let script = "#!/bin/bash\necho \"boom\" >&2\nexit 1\n"
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: executable.path
    )

    do {
      _ = try AgentCommandRunner(
        executableURL: executable,
        configPath: "/work/runtime.yaml"
      ).run(.stop)
      try expect(false, "expected a failure from the non-zero exit status")
    } catch let AgentCommandError.failed(_, status, output) {
      try expect(status == 1, "expected the process exit status to surface")
      try expect(output.contains("boom"), "expected stderr diagnostics on failure")
    }
  }

  static func stopRemainsAvailableWithoutTelemetry() throws {
    try expect(
      isAgentActionEnabled(.stop, connectionState: .stopped, actionInProgress: false),
      "stop must remain available when telemetry is missing"
    )
    try expect(
      !isAgentActionEnabled(.stop, connectionState: .connected, actionInProgress: true),
      "agent actions must remain disabled while another command is running"
    )
    try expect(
      isAgentActionEnabled(.stop, connectionState: .stale, actionInProgress: false),
      "stop must remain available when telemetry is stale"
    )
    try expect(
      isAgentActionEnabled(.reconnect, connectionState: .stale, actionInProgress: false),
      "reconnect must remain available when telemetry is stale"
    )
  }

  static func telemetryReadFailuresRemainUnavailableUntilStatusConfirmsStop() throws {
    try expect(
      telemetryUnavailableState(validatedProcessIsRunning: nil) == .stale,
      "an unreadable snapshot must remain telemetry unavailable before validation"
    )
    try expect(
      telemetryUnavailableState(validatedProcessIsRunning: true) == .stale,
      "a validated live process must remain telemetry unavailable"
    )
    try expect(
      telemetryUnavailableState(validatedProcessIsRunning: false) == .stopped,
      "only validated process status may classify missing telemetry as stopped"
    )
  }

  static func validatedOfflineStateSurvivesTelemetryFailures() throws {
    var tracker = TelemetryUnavailableStateTracker()

    try expect(tracker.connectionState == .stale, "missing telemetry should initially be stale")
    tracker.recordProcessValidation(isRunning: false)
    try expect(
      tracker.connectionState == .stopped, "validated process status should publish Offline")
    try expect(tracker.connectionState == .stopped, "later telemetry failures must retain Offline")
    tracker.reset()
    try expect(
      tracker.connectionState == .stale,
      "successful telemetry should clear prior process validation")
  }

  static func staleTelemetryRequiresTwoObservedMissedPollsAndSurvivesWake() throws {
    let updatedAt = Date(timeIntervalSince1970: 1_000)
    var tracker = TelemetryFreshnessTracker()
    try expect(
      tracker.connectionState(
        reportedState: .connected,
        updatedAt: updatedAt,
        processIsRunning: true,
        now: updatedAt
      ) == .connected,
      "the first observation should be live"
    )
    try expect(
      tracker.connectionState(
        reportedState: .connected,
        updatedAt: updatedAt,
        processIsRunning: true,
        now: updatedAt.addingTimeInterval(3_600)
      ) == .connected,
      "the first observation after wake must receive a grace poll"
    )
    try expect(
      tracker.connectionState(
        reportedState: .connected,
        updatedAt: updatedAt,
        processIsRunning: true,
        now: updatedAt.addingTimeInterval(3_601)
      ) == .stale,
      "telemetry must become stale after two unchanged observations"
    )
    try expect(
      ConnectionTransition(previous: .connected, current: .connected).notification == nil,
      "the wake grace poll must not trigger a false notification"
    )
  }

  static func connectionTransitionsIdentifyNotifications() throws {
    try expect(
      ConnectionTransition(previous: .connected, current: .reconnecting).notification
        == .disconnected,
      "expected disconnect notification"
    )
    try expect(
      ConnectionTransition(previous: .reconnecting, current: .connected).notification
        == .reconnected,
      "expected reconnect notification"
    )
    try expect(
      ConnectionTransition(previous: .connected, current: .connected).notification == nil,
      "stable state should not notify"
    )
    try expect(
      ConnectionTransition(previous: .connected, current: .stale).notification == nil,
      "telemetry loss must not be modeled as a connection transition"
    )
    try expect(
      ConnectionTransition(previous: .stale, current: .connected).notification == nil,
      "telemetry recovery must not be modeled as a connection transition"
    )
  }

  static func telemetryAvailabilityTransitionsRequireSuccessfulDecode() throws {
    try expect(
      TelemetryAvailabilityTransition(previous: .available, current: .unavailable).notification
        == .telemetryUnavailable,
      "a failed telemetry decode should report telemetry unavailable"
    )
    try expect(
      TelemetryAvailabilityTransition(previous: .unavailable, current: .unavailable).notification
        == nil,
      "process validation must not report telemetry restoration"
    )
    try expect(
      TelemetryAvailabilityTransition(previous: .unavailable, current: .available).notification
        == .telemetryRestored,
      "only a successful telemetry decode should report restoration"
    )
  }

  static func runtimeConfigurationsRoundTrip() throws {
    let configPath = "/Users/example/.gsd/custom-runtime.yaml"
    let configuration = RuntimeConfiguration(
      name: "Studio Mac",
      telemetryPath: RuntimeArtifactPaths(configPath: configPath).telemetryPath,
      agentConfigPath: configPath,
      agentExecutablePath: "/opt/homebrew/bin/gsd-cloud"
    )

    let decoded = try JSONDecoder().decode(
      RuntimeConfiguration.self,
      from: JSONEncoder().encode(configuration)
    )

    try expect(decoded == configuration, "runtime configuration should round-trip")
  }

  static func runtimeConfigurationsPreserveCustomAgentConfigPath() throws {
    let configuration = RuntimeConfiguration(
      name: "Custom Runtime",
      telemetryPath: "/work/state/cloud-runtime-status.json",
      agentConfigPath: "/work/config/custom.yaml",
      agentExecutablePath: "/usr/local/bin/gsd-cloud"
    )
    let decoded = try JSONDecoder().decode(
      RuntimeConfiguration.self,
      from: JSONEncoder().encode(configuration)
    )
    try expect(
      decoded.configPath == "/work/config/custom.yaml", "custom config path must round-trip")
  }

  static func runtimeConfigurationEditsPreservePathProvenance() throws {
    var derived = RuntimeConfiguration(
      name: "Derived",
      telemetryPath: RuntimeArtifactPaths(configPath: "/work/first.yaml").telemetryPath,
      telemetryPathIsDerived: true,
      agentConfigPath: "/work/first.yaml",
      agentExecutablePath: "/usr/local/bin/gsd-cloud"
    )
    derived.updateAgentConfigPath("/work/second.yaml")
    try expect(
      derived.telemetryPath == RuntimeArtifactPaths(configPath: "/work/second.yaml").telemetryPath,
      "derived telemetry must follow agent config edits"
    )

    derived.updateTelemetryPath("/var/run/explicit-status.json")
    derived.updateAgentConfigPath("/work/third.yaml")
    try expect(
      !derived.telemetryPathIsDerived, "manual telemetry edits must persist custom provenance")
    try expect(
      derived.telemetryPath == "/var/run/explicit-status.json",
      "explicit telemetry must not follow later config edits"
    )
  }

  static func legacyRuntimeConfigurationsInferTheDefaultAgentConfigPath() throws {
    let id = UUID()
    let data = Data(
      """
      {"id":"\(id.uuidString)","name":"Legacy","telemetryPath":"/work/state/cloud-runtime-status.json","agentExecutablePath":"/usr/local/bin/gsd-cloud"}
      """.utf8)
    let configuration = try JSONDecoder().decode(RuntimeConfiguration.self, from: data)
    try expect(
      configuration.configPath == "/work/state/daemon.yaml",
      "legacy config should retain default path")
  }

  static func savedRuntimeConfigurationsMigrateFormerlyDerivedTelemetryPaths() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsd-cloud-config-migration-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let configPath = root.appendingPathComponent("custom.yaml").path
    let legacyPath = root.appendingPathComponent("cloud-runtime-status.json").path
    let namespacedPath = RuntimeArtifactPaths(configPath: configPath).telemetryPath
    let ambiguous = Data(
      """
      {"id":"\(UUID().uuidString)","name":"Custom","telemetryPath":"\(legacyPath)","agentConfigPath":"\(configPath)","agentExecutablePath":"/usr/local/bin/gsd-cloud"}
      """.utf8)

    let preservedAmbiguous = try JSONDecoder().decode(RuntimeConfiguration.self, from: ambiguous)
    try expect(
      preservedAmbiguous.telemetryPath == legacyPath,
      "ambiguous legacy telemetry paths must be preserved when no artifact proves derivation"
    )

    try Data("{}".utf8).write(to: URL(fileURLWithPath: legacyPath))
    try Data("{}".utf8).write(to: URL(fileURLWithPath: namespacedPath))
    let preservedActiveLegacy = try JSONDecoder().decode(RuntimeConfiguration.self, from: ambiguous)
    try expect(
      preservedActiveLegacy.telemetryPath == legacyPath,
      "an existing legacy telemetry artifact must preserve an ambiguous saved path"
    )
    try FileManager.default.removeItem(atPath: legacyPath)
    let migrated = try JSONDecoder().decode(RuntimeConfiguration.self, from: ambiguous)
    try expect(
      migrated.telemetryPath == namespacedPath, "active namespaced telemetry should migrate")
    try expect(
      migrated.telemetryPathIsDerived, "migrated telemetry should persist derived provenance")

    let explicit = Data(
      """
      {"id":"\(UUID().uuidString)","name":"Custom","telemetryPath":"/var/run/custom-status.json","agentConfigPath":"/work/state/custom.yaml","agentExecutablePath":"/usr/local/bin/gsd-cloud","telemetryPathIsDerived":false}
      """.utf8)
    let preserved = try JSONDecoder().decode(RuntimeConfiguration.self, from: explicit)
    try expect(
      preserved.telemetryPath == "/var/run/custom-status.json",
      "explicit custom telemetry paths must be preserved"
    )

    let encoded = try JSONEncoder().encode(migrated)
    let roundTripped = try JSONDecoder().decode(RuntimeConfiguration.self, from: encoded)
    try expect(roundTripped.telemetryPathIsDerived, "derived provenance must survive persistence")
  }

  static func migratedRuntimeConfigurationsRequestPersistenceOnce() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsd-cloud-config-persistence-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let configPath = root.appendingPathComponent("custom.yaml").path
    let namespacedPath = RuntimeArtifactPaths(configPath: configPath).telemetryPath
    try Data("{}".utf8).write(to: URL(fileURLWithPath: namespacedPath))
    let legacyPath = root.appendingPathComponent("cloud-runtime-status.json").path
    let stored = Data(
      """
      [{"id":"\(UUID().uuidString)","name":"Custom","telemetryPath":"\(legacyPath)","agentConfigPath":"\(configPath)","agentExecutablePath":"/usr/local/bin/gsd-cloud"}]
      """.utf8)

    let firstLoad = try decodeStoredRuntimeConfigurations(stored)
    try expect(firstLoad.migratedData != nil, "a migrated record must request persistence")
    let secondLoad = try decodeStoredRuntimeConfigurations(firstLoad.migratedData!)
    try expect(secondLoad.migratedData == nil, "persisted provenance must not migrate again")
  }

  static func runtimeConfigurationsDeriveDistinctArtifactsInOneDirectory() throws {
    let first = RuntimeArtifactPaths(configPath: "/work/state/first.yaml")
    let second = RuntimeArtifactPaths(configPath: "/work/state/second.yaml")
    let legacy = RuntimeArtifactPaths(configPath: "/work/state/daemon.yaml")

    try expect(
      first.telemetryPath != second.telemetryPath, "custom configs must not share telemetry")
    try expect(first.logPath != second.logPath, "custom configs must not share logs")
    try expect(
      first.telemetryPath == "/work/state/cloud-runtime-58cb3ff924131c6e-status.json",
      "monitor and agent must derive the same stable namespace"
    )
    try expect(
      legacy.telemetryPath == "/work/state/cloud-runtime-status.json",
      "daemon telemetry must keep its legacy name")
    try expect(
      legacy.logPath == "/work/state/cloud-runtime.log", "daemon logs must keep their legacy name")
  }

  static func diagnosticsRedactLocalPaths() throws {
    let telemetryURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("telemetry-\(UUID().uuidString).json")
    let json = """
      {
        "version": 1,
        "pid": 4242,
        "state": "connected",
        "gateway_url": "https://cloud.opengsd.net",
        "started_at": "2026-07-10T12:00:00.000Z",
        "connected_at": "2026-07-10T12:00:01.000Z",
        "updated_at": "2026-07-10T12:00:02.000Z",
        "last_error": null,
        "connection_attempts": 1,
        "reconnects": 0,
        "received_messages": 12,
        "sent_messages": 9,
        "received_bytes": 4096,
        "sent_bytes": 2048,
        "active_requests": 0,
        "projects": [{
          "alias": "private-project",
          "path": "/Users/example/Secret/private-project",
          "repo_identity": "private-repo",
          "state": "idle",
          "active_requests": 0,
          "request_count": 1,
          "error_count": 0,
          "received_bytes": 10,
          "sent_bytes": 20,
          "last_tool": "gsd_status",
          "last_activity_at": "2026-07-10T12:00:02.000Z"
        }],
        "recent_activity": []
      }
      """
    try Data(json.utf8).write(to: telemetryURL)
    defer { try? FileManager.default.removeItem(at: telemetryURL) }
    let telemetry = try RuntimeTelemetryReader().load(from: telemetryURL)

    let report = try DiagnosticsReport(telemetry: telemetry).jsonData()
    let text = String(decoding: report, as: UTF8.self)

    try expect(text.contains("private-project"), "diagnostics should retain project aliases")
    try expect(!text.contains("/Users/example/Secret"), "diagnostics must redact project paths")
    try expect(!text.contains("device_token"), "diagnostics must not contain credentials")
  }

  static func diagnosticsRemainAvailableWithoutTelemetry() throws {
    let configuration = RuntimeConfiguration(
      name: "Broken Runtime",
      telemetryPath: "/Users/example/.gsd/cloud-runtime-status.json",
      agentConfigPath: "/Users/example/.gsd/daemon.yaml",
      agentExecutablePath: "/usr/local/bin/gsd-cloud"
    )

    let report = try DiagnosticsReport(
      telemetry: nil,
      configuration: configuration,
      validatedState: .stopped,
      telemetryError: "The telemetry file could not be decoded."
    ).jsonData()
    let object = try JSONSerialization.jsonObject(with: report) as? [String: Any]

    try expect(
      object?["state"] as? String == "stopped", "diagnostics should include validated state")
    try expect(
      object?["telemetryError"] as? String == "The telemetry file could not be decoded.",
      "diagnostics should include telemetry read failures"
    )
    try expect(
      object?["configPath"] as? String == configuration.configPath,
      "diagnostics should include the selected configuration path"
    )
    try expect(object?["telemetryPath"] != nil, "diagnostics should include the telemetry path")
    try expect(object?["logPath"] != nil, "diagnostics should include the log path")
  }

  static func releaseVersionsCompareMonitorTags() throws {
    guard let current = ReleaseVersion(tag: "gsd-cloud-monitor-v1.9.9"),
      let update = ReleaseVersion(tag: "gsd-cloud-monitor-v1.10.0")
    else {
      throw TestFailure(message: "valid monitor release tags should parse")
    }

    try expect(update > current, "release versions should compare numerically")
    try expect(ReleaseVersion(tag: "v2.0.0") == nil, "unrelated release tags must be ignored")
  }

  static func updateCheckStatesExposeVisibleFeedback() throws {
    let checkedAt = Date(timeIntervalSince1970: 1_000)
    let update = AvailableUpdate(
      version: ReleaseVersion(tag: "gsd-cloud-monitor-v1.2.0")!,
      downloadURL: URL(string: "https://example.com/release")!
    )

    try expect(
      UpdateCheckState.checking.isChecking, "checking state should disable duplicate checks")
    try expect(
      UpdateCheckState.upToDate(checkedAt: checkedAt).lastCheckedAt == checkedAt,
      "up-to-date state should expose its check time"
    )
    try expect(
      UpdateCheckState.updateAvailable(update, checkedAt: checkedAt).availableUpdate == update,
      "available state should retain the release"
    )
    try expect(
      UpdateCheckState.failed("network unavailable", checkedAt: checkedAt).failureMessage
        == "network unavailable",
      "failed state should expose visible feedback"
    )
  }

  static func updateCheckerSearchesAllReleasePages() async throws {
    let unrelated = (0..<100).map { index in
      [
        "tag_name": "v1.\(index).0",
        "html_url": "https://example.com/unrelated/\(index)",
        "draft": false,
        "prerelease": false,
      ] as [String: Any]
    }
    let monitorRelease: [[String: Any]] = [
      [
        "tag_name": "gsd-cloud-monitor-v1.2.0",
        "html_url": "https://example.com/monitor/1.2.0",
        "draft": false,
        "prerelease": false,
      ]
    ]
    let checker = UpdateChecker { request in
      let page = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first(where: { $0.name == "page" })?.value
      let releases = page == "1" ? unrelated : monitorRelease
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: nil
      )!
      return (try JSONSerialization.data(withJSONObject: releases), response)
    }

    let update = try await checker.latestUpdate(currentVersion: "1.0.0")

    try expect(
      update?.version.tag == "gsd-cloud-monitor-v1.2.0", "expected update from second page")
  }

  static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else {
      throw TestFailure(message: message)
    }
  }
}

struct TestFailure: Error, CustomStringConvertible {
  let message: String

  var description: String { message }
}
