import Foundation

enum MonitorFormatting {
  static let bytes: ByteCountFormatter = {
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    formatter.allowedUnits = [.useKB, .useMB, .useGB]
    formatter.includesUnit = true
    formatter.isAdaptive = true
    return formatter
  }()

  static let updatedAt: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .none
    formatter.timeStyle = .medium
    return formatter
  }()

  static func byteCount(_ value: Int64) -> String {
    bytes.string(fromByteCount: value)
  }

  static func byteRate(_ value: Double) -> String {
    if value == 0 { return "0 KB/s" }
    return "\(bytes.string(fromByteCount: Int64(value)))/s"
  }
}
