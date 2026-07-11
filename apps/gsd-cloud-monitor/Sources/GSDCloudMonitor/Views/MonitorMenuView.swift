import AppKit
import GSDCloudMonitorCore
import SwiftUI

struct MonitorMenuView: View {
  @Environment(\.openWindow) private var openWindow
  @ObservedObject var monitor: RuntimeMonitorStore

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      header

      if let telemetry = monitor.telemetry {
        traffic(telemetry)
        projectSummary(telemetry)
        connection(telemetry)
        if let lastError = telemetry.lastError, monitor.connectionState != .connected {
          errorBanner(lastError)
        }
      } else {
        ContentUnavailableView(
          "No Agent Telemetry",
          systemImage: "icloud.slash",
          description: Text(monitor.readError ?? "Start gsd-cloud to begin monitoring.")
        )
        .frame(maxWidth: .infinity, minHeight: 180)
      }

      footer
    }
    .padding(16)
    .frame(width: 360)
  }

  private func projectSummary(_ telemetry: RuntimeTelemetry) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("PROJECTS")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        Spacer()
        Text("\(telemetry.projects.count)")
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
      ForEach(telemetry.projects.prefix(3)) { project in
        HStack(spacing: 8) {
          Circle()
            .fill(project.state.presentationColor)
            .frame(width: 7, height: 7)
          Text(project.alias)
            .lineLimit(1)
          Spacer()
          Text(project.activeToolSummary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      if telemetry.projects.isEmpty {
        Text("No projects advertised")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var header: some View {
    HStack(spacing: 10) {
      Image(systemName: monitor.systemImage)
        .font(.title2)
        .foregroundStyle(monitor.statusColor)
        .symbolEffect(
          .pulse, options: .repeating, isActive: monitor.connectionState == .reconnecting)
      VStack(alignment: .leading, spacing: 2) {
        Text("GSD Cloud Agent")
          .font(.headline)
        Text(monitor.statusTitle)
          .font(.subheadline)
          .foregroundStyle(monitor.statusColor)
      }
      Spacer()
      Button {
        monitor.refresh()
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .buttonStyle(.borderless)
      .help("Refresh now")
    }
  }

  private func traffic(_ telemetry: RuntimeTelemetry) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("TRAFFIC")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      HStack(spacing: 10) {
        MetricCard(
          title: "Received",
          value: MonitorFormatting.byteRate(monitor.trafficRate.receivedBytesPerSecond),
          detail:
            "\(MonitorFormatting.byteCount(telemetry.receivedBytes)) · \(telemetry.receivedMessages) msgs",
          systemImage: "arrow.down",
          tint: .blue
        )
        MetricCard(
          title: "Sent",
          value: MonitorFormatting.byteRate(monitor.trafficRate.sentBytesPerSecond),
          detail:
            "\(MonitorFormatting.byteCount(telemetry.sentBytes)) · \(telemetry.sentMessages) msgs",
          systemImage: "arrow.up",
          tint: .purple
        )
      }
    }
  }

  private func connection(_ telemetry: RuntimeTelemetry) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("CONNECTION")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
        detailRow("Gateway", telemetry.gatewayURL.host ?? telemetry.gatewayURL.absoluteString)
        detailRow("Runtime", telemetry.runtimeName ?? telemetry.runtimeID ?? "Unknown")
        detailRow("Process", "PID \(telemetry.pid)")
        detailRow("Attempts", "\(telemetry.connectionAttempts)")
        detailRow("Reconnects", "\(telemetry.reconnects)")
        detailRow("Active calls", "\(telemetry.activeRequests)")
      }
      .font(.subheadline)
    }
  }

  private func detailRow(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label)
        .foregroundStyle(.secondary)
      Text(value)
        .lineLimit(1)
        .truncationMode(.middle)
    }
  }

  private func errorBanner(_ message: String) -> some View {
    Label(message, systemImage: "exclamationmark.triangle.fill")
      .font(.caption)
      .foregroundStyle(.red)
      .lineLimit(2)
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
  }

  private var footer: some View {
    HStack {
      if let updatedAt = monitor.telemetry?.updatedAt {
        Text("Updated \(MonitorFormatting.updatedAt.string(from: updatedAt))")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      Spacer()
      Button("Dashboard") {
        openWindow(id: "dashboard")
        NSApp.activate(ignoringOtherApps: true)
      }
      SettingsLink {
        Text("Settings")
      }
      Button("Logs") {
        monitor.revealLogs()
      }
      Button("Quit") {
        NSApplication.shared.terminate(nil)
      }
    }
  }
}
