import Foundation

public struct TrafficSample: Identifiable, Sendable {
  public let id = UUID()
  public let at: Date
  public let receivedBytesPerSecond: Double
  public let sentBytesPerSecond: Double
}

public struct TrafficSeries: Sendable {
  public private(set) var samples: [TrafficSample] = []

  private let limit: Int
  private var previousCounters: TrafficCounters?
  private var previousDate: Date?

  public init(limit: Int = 60) {
    self.limit = max(1, limit)
  }

  public mutating func record(counters: TrafficCounters, at date: Date = Date()) {
    let rate: TrafficRate
    if let previousCounters, let previousDate {
      rate = counters.rate(since: previousCounters, elapsed: date.timeIntervalSince(previousDate))
    } else {
      rate = .zero
    }
    previousCounters = counters
    previousDate = date
    samples.append(TrafficSample(
      at: date,
      receivedBytesPerSecond: rate.receivedBytesPerSecond,
      sentBytesPerSecond: rate.sentBytesPerSecond
    ))
    if samples.count > limit {
      samples.removeFirst(samples.count - limit)
    }
  }
}
