import Charts
import GSDCloudMonitorCore
import SwiftUI

struct DashboardView: View {
  @ObservedObject var monitor: RuntimeMonitorStore
  @State private var selection: RuntimeProjectTelemetry.ID?

  var body: some View {
    NavigationSplitView {
      List(selection: $selection) {
        ForEach(monitor.telemetry?.projects ?? []) { project in
          HStack(spacing: 10) {
            Image(
              systemName: project.state == .error ? "exclamationmark.circle.fill" : "folder.fill"
            )
            .foregroundStyle(project.state.presentationColor)
            .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
              Text(project.alias)
                .lineLimit(1)
              Text(project.remoteLabel ?? "\(project.requestCount) requests")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
          }
          .tag(project.id)
        }
      }
      .listStyle(.sidebar)
      .navigationTitle("Projects")
    } detail: {
      if let project = selectedProject {
        ProjectDetailView(project: project, monitor: monitor)
      } else {
        ContentUnavailableView(
          "Select a Project",
          systemImage: "folder",
          description: Text("Choose an advertised project to inspect its traffic and activity.")
        )
      }
    }
    .onAppear { selectFirstProjectIfNeeded() }
    .onChange(of: monitor.telemetry?.projects.map(\.id)) { _, _ in
      selectFirstProjectIfNeeded()
    }
    .toolbar {
      ToolbarItemGroup {
        Picker("Runtime", selection: selectedRuntime) {
          ForEach(monitor.configurations) { configuration in
            Text(configuration.name).tag(configuration.id)
          }
        }
        .frame(maxWidth: 180)
        Button("Start") { monitor.runAgentAction(.start) }
          .disabled(
            !isAgentActionEnabled(
              .start,
              connectionState: monitor.connectionState,
              actionInProgress: monitor.actionInProgress
            ))
        Button("Stop") { monitor.runAgentAction(.stop) }
          .disabled(
            !isAgentActionEnabled(
              .stop,
              connectionState: monitor.connectionState,
              actionInProgress: monitor.actionInProgress
            ))
        Button("Reconnect") { monitor.runAgentAction(.reconnect) }
          .disabled(
            !isAgentActionEnabled(
              .reconnect,
              connectionState: monitor.connectionState,
              actionInProgress: monitor.actionInProgress
            ))
        Button {
          monitor.exportDiagnostics()
        } label: {
          Label("Export Diagnostics", systemImage: "square.and.arrow.up")
        }
        Button {
          monitor.refresh()
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
      }
    }
    .safeAreaInset(edge: .bottom) {
      if let message = monitor.actionMessage {
        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(.bar)
      }
    }
  }

  private var selectedProject: RuntimeProjectTelemetry? {
    monitor.telemetry?.projects.first { $0.id == selection }
  }

  private var selectedRuntime: Binding<UUID> {
    Binding(
      get: { monitor.selectedConfigurationID },
      set: { monitor.selectConfiguration($0) }
    )
  }

  private func selectFirstProjectIfNeeded() {
    let projects = monitor.telemetry?.projects ?? []
    if !projects.contains(where: { $0.id == selection }) {
      selection = projects.first?.id
    }
  }
}

private struct ProjectDetailView: View {
  let project: RuntimeProjectTelemetry
  @ObservedObject var monitor: RuntimeMonitorStore

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        metrics
        trafficChart
        activity
      }
      .padding(24)
    }
    .navigationTitle(project.alias)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Text(project.alias)
          .font(.largeTitle.bold())
        Spacer()
        Label(project.state.rawValue.capitalized, systemImage: stateImage)
          .foregroundStyle(stateColor)
      }
      Text(project.remoteLabel ?? project.path)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
      if !project.activeTools.isEmpty {
        Label(project.activeToolSummary, systemImage: "hammer.fill")
          .font(.subheadline.monospaced())
          .foregroundStyle(.green)
      }
    }
  }

  private var metrics: some View {
    let rate = monitor.trafficRate(for: project)
    return HStack(spacing: 12) {
      MetricCard(
        title: "Received",
        value: MonitorFormatting.byteRate(rate.receivedBytesPerSecond),
        detail: MonitorFormatting.byteCount(project.receivedBytes),
        systemImage: "arrow.down",
        tint: .blue
      )
      MetricCard(
        title: "Sent",
        value: MonitorFormatting.byteRate(rate.sentBytesPerSecond),
        detail: MonitorFormatting.byteCount(project.sentBytes),
        systemImage: "arrow.up",
        tint: .purple
      )
      MetricCard(
        title: "Requests",
        value: "\(project.requestCount)",
        detail: "\(project.activeRequests) active · \(project.errorCount) errors",
        systemImage: "bolt.horizontal.fill",
        tint: .orange
      )
    }
  }

  private var trafficChart: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Traffic · Last 60 seconds")
        .font(.headline)
      Chart {
        ForEach(monitor.trafficHistory(for: project)) { sample in
          LineMark(
            x: .value("Time", sample.at),
            y: .value("Bytes per second", sample.receivedBytesPerSecond)
          )
          .foregroundStyle(by: .value("Direction", "Received"))
          LineMark(
            x: .value("Time", sample.at),
            y: .value("Bytes per second", sample.sentBytesPerSecond)
          )
          .foregroundStyle(by: .value("Direction", "Sent"))
        }
      }
      .chartForegroundStyleScale(["Received": Color.blue, "Sent": Color.purple])
      .frame(height: 180)
    }
    .padding(16)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
  }

  private var activity: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Recent Activity")
        .font(.headline)
      ForEach(recentActivity) { item in
        HStack(spacing: 10) {
          Image(systemName: activityImage(item.outcome))
            .foregroundStyle(activityColor(item.outcome))
            .frame(width: 16)
          VStack(alignment: .leading, spacing: 2) {
            Text(item.toolName)
              .font(.body.monospaced())
            if let error = item.error {
              Text(error)
                .font(.caption)
                .foregroundStyle(.red)
                .lineLimit(1)
            }
          }
          Spacer()
          Text("\(item.durationMs) ms")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
      }
      if recentActivity.isEmpty {
        Text("No recent activity")
          .foregroundStyle(.secondary)
      }
    }
  }

  private var recentActivity: [RuntimeActivity] {
    Array(
      (monitor.telemetry?.recentActivity ?? [])
        .filter { $0.belongs(to: project) }
        .suffix(12)
        .reversed())
  }

  private var stateImage: String {
    switch project.state {
    case .idle: "pause.circle"
    case .active: "bolt.circle.fill"
    case .error: "exclamationmark.circle.fill"
    }
  }

  private var stateColor: Color {
    project.state.presentationColor
  }

  private func activityImage(_ outcome: RuntimeActivityOutcome) -> String {
    switch outcome {
    case .success: "checkmark.circle.fill"
    case .error: "xmark.circle.fill"
    case .cancelled: "minus.circle.fill"
    }
  }

  private func activityColor(_ outcome: RuntimeActivityOutcome) -> Color {
    switch outcome {
    case .success: .green
    case .error: .red
    case .cancelled: .secondary
    }
  }
}
