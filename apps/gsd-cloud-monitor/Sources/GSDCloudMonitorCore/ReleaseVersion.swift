public struct ReleaseVersion: Comparable, Sendable {
  public static let tagPrefix = "gsd-cloud-monitor-v"

  public let major: Int
  public let minor: Int
  public let patch: Int
  public let tag: String

  public init?(tag: String) {
    guard tag.hasPrefix(Self.tagPrefix) else { return nil }
    let version = tag.dropFirst(Self.tagPrefix.count)
    let parts = version.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3,
      let major = Int(parts[0]),
      let minor = Int(parts[1]),
      let patch = Int(parts[2])
    else {
      return nil
    }
    self.major = major
    self.minor = minor
    self.patch = patch
    self.tag = tag
  }

  public static func < (lhs: ReleaseVersion, rhs: ReleaseVersion) -> Bool {
    if lhs.major != rhs.major { return lhs.major < rhs.major }
    if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
    return lhs.patch < rhs.patch
  }
}
