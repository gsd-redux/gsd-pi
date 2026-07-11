import Foundation
import GSDCloudMonitorCore
import UserNotifications

struct NotificationService {
  func requestAuthorization() async throws -> Bool {
    try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
  }

  func post(_ notification: ConnectionNotification, runtimeName: String?) {
    let content = UNMutableNotificationContent()
    content.title = runtimeName ?? "GSD Cloud Agent"
    switch notification {
    case .disconnected:
      content.body = "The cloud agent disconnected and is trying to reconnect."
    case .reconnected:
      content.body = "The cloud agent reconnected."
    case .error:
      content.body = "The cloud agent reported a connection error."
    case .telemetryUnavailable:
      content.body = "Cloud agent telemetry is temporarily unavailable."
    case .telemetryRestored:
      content.body = "Cloud agent telemetry is available again."
    }
    content.sound = .default
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    )
  }
}
