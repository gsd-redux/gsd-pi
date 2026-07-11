public enum ConnectionNotification: Sendable {
  case disconnected
  case reconnected
  case error
  case telemetryUnavailable
  case telemetryRestored
}

public enum TelemetryAvailability: Sendable {
  case available
  case unavailable
}

public struct TelemetryAvailabilityTransition: Sendable {
  public let previous: TelemetryAvailability
  public let current: TelemetryAvailability

  public init(previous: TelemetryAvailability, current: TelemetryAvailability) {
    self.previous = previous
    self.current = current
  }

  public var notification: ConnectionNotification? {
    switch (previous, current) {
    case (.available, .unavailable): .telemetryUnavailable
    case (.unavailable, .available): .telemetryRestored
    default: nil
    }
  }
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
    if previous == .connected && (current == .reconnecting || current == .stopped) {
      return .disconnected
    }
    if (previous == .reconnecting || previous == .stopped) && current == .connected {
      return .reconnected
    }
    return nil
  }
}
