public enum ConnectionNotification: Sendable {
  case disconnected
  case reconnected
  case error
  case telemetryUnavailable
  case telemetryRestored
}

public struct ConnectionTransition: Sendable {
  public let previous: RuntimeConnectionState
  public let current: RuntimeConnectionState

  public init(previous: RuntimeConnectionState, current: RuntimeConnectionState) {
    self.previous = previous
    self.current = current
  }

  public var notification: ConnectionNotification? {
    if current == .error && previous != .error {
      return .error
    }
    if current == .stale && previous != .stale {
      return .telemetryUnavailable
    }
    if previous == .stale && current != .stale {
      return .telemetryRestored
    }
    if previous == .connected && (current == .reconnecting || current == .stopped) {
      return .disconnected
    }
    if (previous == .reconnecting || previous == .stopped) && current == .connected {
      return .reconnected
    }
    return nil
  }
}
