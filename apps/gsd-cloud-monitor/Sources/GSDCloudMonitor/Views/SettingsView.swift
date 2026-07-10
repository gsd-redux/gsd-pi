import ServiceManagement
import SwiftUI

struct MonitorSettingsView: View {
  @ObservedObject var monitor: RuntimeMonitorStore
  @AppStorage("notificationsEnabled") private var notificationsEnabled = false
  @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
  @State private var launchError: String?

  var body: some View {
    Form {
      Section("Runtimes") {
        Picker("Runtime", selection: selectedConfigurationID) {
          ForEach(monitor.configurations) { configuration in
            Text(configuration.name).tag(configuration.id)
          }
        }
        TextField("Name", text: name)
        TextField("Telemetry file", text: telemetryPath)
        TextField("gsd-cloud executable", text: agentExecutablePath)
        HStack {
          Button("Add Runtime") { monitor.addConfiguration() }
          Button("Remove Runtime", role: .destructive) {
            monitor.removeSelectedConfiguration()
          }
          .disabled(monitor.configurations.count == 1)
        }
      }

      Section("Behavior") {
        Toggle("Notify on connection changes", isOn: $notificationsEnabled)
          .onChange(of: notificationsEnabled) { _, enabled in
            if enabled { monitor.requestNotificationAuthorization() }
          }
        Toggle("Launch at login", isOn: $launchAtLogin)
          .onChange(of: launchAtLogin) { _, enabled in
            updateLaunchAtLogin(enabled)
          }
        if let launchError {
          Text(launchError)
            .foregroundStyle(.red)
        }
      }

      Section("Updates") {
        if let update = monitor.availableUpdate {
          Button("Download \(update.version.tag)") {
            monitor.openAvailableUpdate()
          }
        } else {
          Button("Check for Updates") { monitor.checkForUpdates() }
        }
      }
    }
    .formStyle(.grouped)
    .frame(width: 520)
    .scenePadding()
  }

  private var selectedConfigurationID: Binding<UUID> {
    Binding(
      get: { monitor.selectedConfigurationID },
      set: { monitor.selectConfiguration($0) }
    )
  }

  private var name: Binding<String> {
    Binding(
      get: { monitor.selectedConfiguration.name },
      set: { monitor.updateSelectedConfiguration(name: $0) }
    )
  }

  private var telemetryPath: Binding<String> {
    Binding(
      get: { monitor.selectedConfiguration.telemetryPath },
      set: { monitor.updateSelectedConfiguration(telemetryPath: $0) }
    )
  }

  private var agentExecutablePath: Binding<String> {
    Binding(
      get: { monitor.selectedConfiguration.agentExecutablePath },
      set: { monitor.updateSelectedConfiguration(agentExecutablePath: $0) }
    )
  }

  private func updateLaunchAtLogin(_ enabled: Bool) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      launchError = nil
    } catch {
      launchError = error.localizedDescription
      launchAtLogin = SMAppService.mainApp.status == .enabled
    }
  }
}
