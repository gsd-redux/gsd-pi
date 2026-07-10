public enum ConnectionNotification: Sendable {
  case disconnected
  case reconnected
  case error
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
    if previous == .connected && current != .connected {
      return .disconnected
    }
    if previous != .connected && current == .connected {
      return .reconnected
    }
    return nil
  }
}
