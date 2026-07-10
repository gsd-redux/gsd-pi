import SwiftUI

struct MetricCard: View {
  let title: String
  let value: String
  let detail: String
  let systemImage: String
  let tint: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label(title, systemImage: systemImage)
        .font(.caption)
        .foregroundStyle(.secondary)
      Text(value)
        .font(.system(.title3, design: .rounded, weight: .semibold))
        .monospacedDigit()
      Text(detail)
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
  }
}
