import Darwin
import Foundation
import GSDCloudMonitorCore
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class RuntimeMonitorStore: ObservableObject {
  private static let pollingInterval: TimeInterval = 1

  @Published private(set) var telemetry: RuntimeTelemetry?
  @Published private(set) var trafficRate = TrafficRate.zero
  @Published private(set) var trafficHistory: [TrafficSample] = []
  @Published private(set) var readError: String?
  @Published private(set) var configurations: [RuntimeConfiguration]
  @Published private(set) var selectedConfigurationID: RuntimeConfiguration.ID
  @Published private(set) var actionInProgress = false
  @Published private(set) var actionMessage: String?
  @Published private(set) var updateCheckState = UpdateCheckState.idle

  private let reader = RuntimeTelemetryReader()
  private let notificationService = NotificationService()
  private let persistsConfigurations: Bool
  private var totalTraffic = TrafficSeries()
  private var projectTraffic: [String: TrafficSeries] = [:]
  private var previousConnectionState: RuntimeConnectionState?
  private var previousTelemetryAvailability: TelemetryAvailability?
  private var freshnessTracker = TelemetryFreshnessTracker()
  private var telemetryUnavailableStateTracker = TelemetryUnavailableStateTracker()
  @Published private var monitoredState: RuntimeConnectionState = .stopped
  private var statusCheckInProgress = false
  private var timer: Timer?

  init(telemetryURL: URL? = nil) {
    if let telemetryURL {
      let preview = RuntimeConfiguration(
        name: "Preview",
        telemetryPath: telemetryURL.path,
        telemetryPathIsDerived: false,
        agentConfigPath: telemetryURL.deletingLastPathComponent().appendingPathComponent(
          "daemon.yaml"
        ).path,
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
    timer = Timer.scheduledTimer(withTimeInterval: Self.pollingInterval, repeats: true) {
      [weak self] _ in
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
    monitoredState
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
    case .stale: "questionmark.circle"
    }
  }

  var statusTitle: String {
    switch connectionState {
    case .connected: "Connected"
    case .connecting: "Connecting"
    case .reconnecting: "Reconnecting"
    case .error: "Connection Error"
    case .stopped: "Agent Offline"
    case .stale: "Telemetry Stale"
    }
  }

  var statusColor: Color {
    switch connectionState {
    case .connected: .green
    case .connecting, .reconnecting: .orange
    case .error: .red
    case .stopped: .secondary
    case .stale: .orange
    }
  }

  func refresh() {
    do {
      let current = try reader.load(from: selectedConfiguration.telemetryURL)
      let now = Date()
      let sourceID = selectedConfiguration.telemetryURL.standardizedFileURL.path
      totalTraffic.record(counters: current.trafficCounters, sourceID: sourceID, at: now)
      trafficHistory = totalTraffic.samples
      if let latest = trafficHistory.last {
        trafficRate = TrafficRate(
          receivedBytesPerSecond: latest.receivedBytesPerSecond,
          sentBytesPerSecond: latest.sentBytesPerSecond
        )
      }
      for project in current.projects {
        var series = projectTraffic[project.id] ?? TrafficSeries()
        series.record(counters: project.trafficCounters, sourceID: sourceID, at: now)
        projectTraffic[project.id] = series
      }
      let currentProjectIDs = Set(current.projects.map(\.id))
      projectTraffic = projectTraffic.filter { currentProjectIDs.contains($0.key) }
      telemetry = current
      telemetryUnavailableStateTracker.reset()
      handleTelemetryAvailability(.available)
      monitoredState = freshnessTracker.connectionState(
        reportedState: current.state,
        updatedAt: current.updatedAt,
        processIsRunning: processIsRunning(current.pid)
      )
      readError = nil
      handleConnectionTransition(to: monitoredState)
    } catch {
      telemetry = nil
      monitoredState = telemetryUnavailableStateTracker.connectionState
      handleTelemetryAvailability(.unavailable)
      freshnessTracker.reset()
      trafficRate = .zero
      trafficHistory = []
      totalTraffic = TrafficSeries()
      projectTraffic = [:]
      readError =
        (error as NSError).code == NSFileReadNoSuchFileError
        ? "Waiting for gsd-cloud telemetry"
        : error.localizedDescription
      validateRuntimeStatus()
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
    let logURL = URL(
      fileURLWithPath: RuntimeArtifactPaths(
        configPath: selectedConfiguration.configPath
      ).logPath)
    let directory = logURL.deletingLastPathComponent()
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
      telemetryPathIsDerived: true,
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
    guard let index = configurations.firstIndex(where: { $0.id == selectedConfigurationID }) else {
      return
    }
    let previousTelemetryPath = configurations[index].telemetryPath
    if let name { configurations[index].name = name }
    if let telemetryPath { configurations[index].updateTelemetryPath(telemetryPath) }
    if let agentConfigPath {
      configurations[index].updateAgentConfigPath(agentConfigPath)
    }
    if let agentExecutablePath { configurations[index].agentExecutablePath = agentExecutablePath }
    if configurations[index].telemetryPath != previousTelemetryPath { resetSamples() }
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
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "gsd-cloud-diagnostics.json"
    panel.allowedContentTypes = [.json]
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      try DiagnosticsReport(
        telemetry: telemetry,
        configuration: selectedConfiguration,
        validatedState: connectionState,
        telemetryError: readError
      ).jsonData().write(to: url, options: .atomic)
      actionMessage = "Diagnostics exported."
    } catch {
      actionMessage = error.localizedDescription
    }
  }

  func checkForUpdates() {
    guard !updateCheckState.isChecking else { return }
    let version =
      Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    updateCheckState = .checking
    Task {
      do {
        if let update = try await UpdateChecker().latestUpdate(currentVersion: version) {
          updateCheckState = .updateAvailable(update, checkedAt: Date())
        } else {
          updateCheckState = .upToDate(checkedAt: Date())
        }
      } catch {
        updateCheckState = .failed(error.localizedDescription, checkedAt: Date())
      }
    }
  }

  func openAvailableUpdate() {
    guard let url = updateCheckState.availableUpdate?.downloadURL else { return }
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
      ).notification
    else {
      return
    }
    notificationService.post(notification, runtimeName: telemetry?.runtimeName)
  }

  private func handleTelemetryAvailability(_ availability: TelemetryAvailability) {
    defer { previousTelemetryAvailability = availability }
    guard let previousTelemetryAvailability,
      UserDefaults.standard.bool(forKey: "notificationsEnabled"),
      let notification = TelemetryAvailabilityTransition(
        previous: previousTelemetryAvailability,
        current: availability
      ).notification
    else {
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
    previousTelemetryAvailability = nil
    monitoredState = .stopped
    freshnessTracker.reset()
    telemetryUnavailableStateTracker.reset()
  }

  private func validateRuntimeStatus() {
    guard !statusCheckInProgress else { return }
    let configuration = selectedConfiguration
    guard FileManager.default.isExecutableFile(atPath: configuration.agentExecutableURL.path) else {
      return
    }
    statusCheckInProgress = true
    let runner = AgentCommandRunner(
      executableURL: configuration.agentExecutableURL,
      configPath: configuration.configPath
    )
    Task {
      let isRunning = try? await Task.detached { try runner.runtimeIsRunning() }.value
      statusCheckInProgress = false
      guard selectedConfigurationID == configuration.id, telemetry == nil else { return }
      telemetryUnavailableStateTracker.recordProcessValidation(isRunning: isRunning)
      monitoredState = telemetryUnavailableStateTracker.connectionState
      if isRunning == false {
        handleConnectionTransition(to: monitoredState)
      }
    }
  }

  private func persistConfigurations() {
    guard persistsConfigurations else { return }
    if let data = try? JSONEncoder().encode(configurations) {
      UserDefaults.standard.set(data, forKey: "runtimeConfigurations")
      UserDefaults.standard.set(
        selectedConfigurationID.uuidString, forKey: "selectedRuntimeConfiguration")
    }
  }

  private static func loadConfigurations() -> (
    configurations: [RuntimeConfiguration],
    selectedID: RuntimeConfiguration.ID
  ) {
    if let data = UserDefaults.standard.data(forKey: "runtimeConfigurations"),
      let decoded = try? decodeStoredRuntimeConfigurations(data),
      let first = decoded.configurations.first
    {
      let saved = decoded.configurations
      if let migratedData = decoded.migratedData {
        UserDefaults.standard.set(migratedData, forKey: "runtimeConfigurations")
      }
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
      telemetryPathIsDerived: true,
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
