import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var previewWindow: NSWindow?

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard CommandLine.arguments.contains("--preview-window") else {
      NSApp.setActivationPolicy(.accessory)
      return
    }
    NSApp.setActivationPolicy(.regular)
    let telemetryURL = previewTelemetryURL()
    let monitor = RuntimeMonitorStore(telemetryURL: telemetryURL)
    let content = NSHostingController(
      rootView: DashboardView(monitor: monitor)
    )
    let window = NSWindow(contentViewController: content)
    window.title = "GSD Cloud Monitor"
    window.styleMask = [.titled, .closable, .resizable]
    window.setContentSize(NSSize(width: 920, height: 640))
    window.isReleasedWhenClosed = false
    window.center()
    window.makeKeyAndOrderFront(nil)
    previewWindow = window
    NSApp.activate(ignoringOtherApps: true)
  }

  private func previewTelemetryURL() -> URL? {
    guard let flagIndex = CommandLine.arguments.firstIndex(of: "--telemetry-path") else {
      return nil
    }
    let pathIndex = CommandLine.arguments.index(after: flagIndex)
    guard CommandLine.arguments.indices.contains(pathIndex) else { return nil }
    return URL(fileURLWithPath: CommandLine.arguments[pathIndex])
  }
}

@main
struct GSDCloudMonitorApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var monitor = RuntimeMonitorStore()

  var body: some Scene {
    MenuBarExtra {
      MonitorMenuView(monitor: monitor)
    } label: {
      Label("GSD Cloud", systemImage: monitor.systemImage)
    }
    .menuBarExtraStyle(.window)

    Window("GSD Cloud Dashboard", id: "dashboard") {
      DashboardView(monitor: monitor)
    }
    .defaultSize(width: 920, height: 640)

    Settings {
      MonitorSettingsView(monitor: monitor)
    }
  }
}
