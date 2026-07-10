import Darwin
import Foundation
import GSDCloudMonitorCore
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class RuntimeMonitorStore: ObservableObject {
  @Published private(set) var telemetry: RuntimeTelemetry?
  @Published private(set) var trafficRate = TrafficRate.zero
  @Published private(set) var trafficHistory: [TrafficSample] = []
  @Published private(set) var readError: String?
  @Published private(set) var configurations: [RuntimeConfiguration]
  @Published private(set) var selectedConfigurationID: RuntimeConfiguration.ID
  @Published private(set) var actionInProgress = false
  @Published private(set) var actionMessage: String?
  @Published private(set) var availableUpdate: AvailableUpdate?

  private let reader = RuntimeTelemetryReader()
  private let notificationService = NotificationService()
  private let persistsConfigurations: Bool
  private var totalTraffic = TrafficSeries()
  private var projectTraffic: [String: TrafficSeries] = [:]
  private var previousConnectionState: RuntimeConnectionState?
  private var timer: Timer?

  init(telemetryURL: URL? = nil) {
    if let telemetryURL {
      let preview = RuntimeConfiguration(
        name: "Preview",
        telemetryPath: telemetryURL.path,
        agentConfigPath: telemetryURL.deletingLastPathComponent().appendingPathComponent("daemon.yaml").path,
        agentExecutablePath: "/usr/bin/false"
      )
      configurations = [preview]
      selectedConfigurationID = preview.id
      persistsConfigurations = false
    } else {
      let saved = RuntimeMonitorStore.loadConfigurations()
      configurations = saved.configurations
      selectedConfigurationID = saved.selectedID
      persistsConfigurations = true
    }
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
    if telemetryURL == nil {
      checkForUpdates()
    }
  }

  deinit {
    timer?.invalidate()
  }

  var connectionState: RuntimeConnectionState {
    guard let telemetry else { return .stopped }
    return processIsRunning(telemetry.pid) ? telemetry.state : .stopped
  }

  var selectedConfiguration: RuntimeConfiguration {
    configurations.first { $0.id == selectedConfigurationID } ?? configurations[0]
  }

  var systemImage: String {
    switch connectionState {
    case .connected: "cloud.fill"
    case .connecting, .reconnecting: "arrow.triangle.2.circlepath"
    case .error: "exclamationmark.icloud.fill"
    case .stopped: "icloud.slash"
    }
  }

  var statusTitle: String {
    switch connectionState {
    case .connected: "Connected"
    case .connecting: "Connecting"
    case .reconnecting: "Reconnecting"
    case .error: "Connection Error"
    case .stopped: "Agent Offline"
    }
  }

  var statusColor: Color {
    switch connectionState {
    case .connected: .green
    case .connecting, .reconnecting: .orange
    case .error: .red
    case .stopped: .secondary
    }
  }

  func refresh() {
    do {
      let current = try reader.load(from: selectedConfiguration.telemetryURL)
      let now = Date()
      totalTraffic.record(counters: current.trafficCounters, at: now)
      trafficHistory = totalTraffic.samples
      if let latest = trafficHistory.last {
        trafficRate = TrafficRate(
          receivedBytesPerSecond: latest.receivedBytesPerSecond,
          sentBytesPerSecond: latest.sentBytesPerSecond
        )
      }
      for project in current.projects {
        var series = projectTraffic[project.id] ?? TrafficSeries()
        series.record(counters: project.trafficCounters, at: now)
        projectTraffic[project.id] = series
      }
      telemetry = current
      readError = nil
      handleConnectionTransition(to: connectionState)
    } catch {
      handleConnectionTransition(to: .stopped)
      telemetry = nil
      trafficRate = .zero
      trafficHistory = []
      totalTraffic = TrafficSeries()
      projectTraffic = [:]
      readError = (error as NSError).code == NSFileReadNoSuchFileError
        ? "Waiting for gsd-cloud telemetry"
        : error.localizedDescription
    }
  }

  func trafficRate(for project: RuntimeProjectTelemetry) -> TrafficRate {
    guard let latest = projectTraffic[project.id]?.samples.last else { return .zero }
    return TrafficRate(
      receivedBytesPerSecond: latest.receivedBytesPerSecond,
      sentBytesPerSecond: latest.sentBytesPerSecond
    )
  }

  func trafficHistory(for project: RuntimeProjectTelemetry) -> [TrafficSample] {
    projectTraffic[project.id]?.samples ?? []
  }

  func revealLogs() {
    let telemetryURL = selectedConfiguration.telemetryURL
    let directory = telemetryURL.deletingLastPathComponent()
    let logURL = directory.appendingPathComponent("cloud-runtime.log")
    if FileManager.default.fileExists(atPath: logURL.path) {
      NSWorkspace.shared.activateFileViewerSelecting([logURL])
    } else {
      NSWorkspace.shared.open(directory)
    }
  }

  func selectConfiguration(_ id: RuntimeConfiguration.ID) {
    guard configurations.contains(where: { $0.id == id }) else { return }
    selectedConfigurationID = id
    resetSamples()
    persistConfigurations()
    refresh()
  }

  func addConfiguration() {
    let configuration = RuntimeConfiguration(
      name: "New Runtime",
      telemetryPath: RuntimeMonitorStore.defaultTelemetryURL.path,
      agentConfigPath: RuntimeMonitorStore.defaultAgentConfigURL.path,
      agentExecutablePath: RuntimeMonitorStore.defaultAgentExecutablePath
    )
    configurations.append(configuration)
    selectConfiguration(configuration.id)
  }

  func removeSelectedConfiguration() {
    guard configurations.count > 1 else { return }
    configurations.removeAll { $0.id == selectedConfigurationID }
    selectedConfigurationID = configurations[0].id
    resetSamples()
    persistConfigurations()
    refresh()
  }

  func updateSelectedConfiguration(
    name: String? = nil,
    telemetryPath: String? = nil,
    agentConfigPath: String? = nil,
    agentExecutablePath: String? = nil
  ) {
    guard let index = configurations.firstIndex(where: { $0.id == selectedConfigurationID }) else { return }
    if let name { configurations[index].name = name }
    if let telemetryPath { configurations[index].telemetryPath = telemetryPath }
    if let agentConfigPath { configurations[index].agentConfigPath = agentConfigPath }
    if let agentExecutablePath { configurations[index].agentExecutablePath = agentExecutablePath }
    persistConfigurations()
  }

  func runAgentAction(_ action: AgentControlAction) {
    guard !actionInProgress else { return }
    let configuration = selectedConfiguration
    guard FileManager.default.isExecutableFile(atPath: configuration.agentExecutableURL.path) else {
      actionMessage = "Set a valid gsd-cloud executable in Settings."
      return
    }
    let runner = AgentCommandRunner(
      executableURL: configuration.agentExecutableURL,
      configPath: configuration.configPath
    )
    actionInProgress = true
    actionMessage = nil
    Task {
      do {
        let result = try await Task.detached { try runner.run(action) }.value
        actionMessage = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        refresh()
      } catch {
        actionMessage = error.localizedDescription
      }
      actionInProgress = false
    }
  }

  func requestNotificationAuthorization() {
    Task {
      do {
        let allowed = try await notificationService.requestAuthorization()
        if !allowed {
          UserDefaults.standard.set(false, forKey: "notificationsEnabled")
        }
      } catch {
        actionMessage = error.localizedDescription
        UserDefaults.standard.set(false, forKey: "notificationsEnabled")
      }
    }
  }

  func exportDiagnostics() {
    guard let telemetry else {
      actionMessage = "No telemetry is available to export."
      return
    }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "gsd-cloud-diagnostics.json"
    panel.allowedContentTypes = [.json]
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      try DiagnosticsReport(telemetry: telemetry).jsonData().write(to: url, options: .atomic)
      actionMessage = "Diagnostics exported."
    } catch {
      actionMessage = error.localizedDescription
    }
  }

  func checkForUpdates() {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    Task {
      availableUpdate = try? await UpdateChecker().latestUpdate(currentVersion: version)
    }
  }

  func openAvailableUpdate() {
    guard let url = availableUpdate?.downloadURL else { return }
    NSWorkspace.shared.open(url)
  }

  private func processIsRunning(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0 || errno == EPERM
  }

  private func handleConnectionTransition(to state: RuntimeConnectionState) {
    defer { previousConnectionState = state }
    guard let previousConnectionState,
          UserDefaults.standard.bool(forKey: "notificationsEnabled"),
          let notification = ConnectionTransition(
            previous: previousConnectionState,
            current: state
          ).notification else {
      return
    }
    notificationService.post(notification, runtimeName: telemetry?.runtimeName)
  }

  private func resetSamples() {
    telemetry = nil
    trafficRate = .zero
    trafficHistory = []
    totalTraffic = TrafficSeries()
    projectTraffic = [:]
    previousConnectionState = nil
  }

  private func persistConfigurations() {
    guard persistsConfigurations else { return }
    if let data = try? JSONEncoder().encode(configurations) {
      UserDefaults.standard.set(data, forKey: "runtimeConfigurations")
      UserDefaults.standard.set(selectedConfigurationID.uuidString, forKey: "selectedRuntimeConfiguration")
    }
  }

  private static func loadConfigurations() -> (
    configurations: [RuntimeConfiguration],
    selectedID: RuntimeConfiguration.ID
  ) {
    if let data = UserDefaults.standard.data(forKey: "runtimeConfigurations"),
       let saved = try? JSONDecoder().decode([RuntimeConfiguration].self, from: data),
       let first = saved.first {
      let selected = UserDefaults.standard.string(forKey: "selectedRuntimeConfiguration")
        .flatMap(UUID.init(uuidString:))
      let selectedID: RuntimeConfiguration.ID
      if let selected, saved.contains(where: { $0.id == selected }) {
        selectedID = selected
      } else {
        selectedID = first.id
      }
      return (saved, selectedID)
    }
    let initial = RuntimeConfiguration(
      name: "Local Runtime",
      telemetryPath: defaultTelemetryURL.path,
      agentConfigPath: defaultAgentConfigURL.path,
      agentExecutablePath: defaultAgentExecutablePath
    )
    return ([initial], initial.id)
  }

  private static var defaultTelemetryURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".gsd", isDirectory: true)
      .appendingPathComponent("cloud-runtime-status.json")
  }

  private static var defaultAgentConfigURL: URL {
    defaultTelemetryURL.deletingLastPathComponent().appendingPathComponent("daemon.yaml")
  }

  private static var defaultAgentExecutablePath: String {
    let candidates = [
      ProcessInfo.processInfo.environment["GSD_CLOUD_BINARY"],
      "/opt/homebrew/bin/gsd-cloud",
      "/usr/local/bin/gsd-cloud",
      FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/bin/gsd-cloud").path,
    ].compactMap { $0 }
    return candidates.first(where: FileManager.default.isExecutableFile(atPath:))
      ?? "/opt/homebrew/bin/gsd-cloud"
  }
}
