import GSDCloudMonitorCore
import SwiftUI

extension RuntimeProjectState {
  var presentationColor: Color {
    switch self {
    case .idle: .secondary
    case .active: .green
    case .error: .red
    }
  }
}
