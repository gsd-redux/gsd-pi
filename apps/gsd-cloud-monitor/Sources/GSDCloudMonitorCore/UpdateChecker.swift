import Foundation

public struct AvailableUpdate: Equatable, Sendable {
  public let version: ReleaseVersion
  public let downloadURL: URL

  public init(version: ReleaseVersion, downloadURL: URL) {
    self.version = version
    self.downloadURL = downloadURL
  }
}

public enum UpdateCheckState: Equatable, Sendable {
  case idle
  case checking
  case upToDate(checkedAt: Date)
  case updateAvailable(AvailableUpdate, checkedAt: Date)
  case failed(String, checkedAt: Date)

  public var isChecking: Bool {
    if case .checking = self { return true }
    return false
  }

  public var availableUpdate: AvailableUpdate? {
    if case .updateAvailable(let update, _) = self { return update }
    return nil
  }

  public var lastCheckedAt: Date? {
    switch self {
    case .idle, .checking: nil
    case .upToDate(let checkedAt), .updateAvailable(_, let checkedAt), .failed(_, let checkedAt):
      checkedAt
    }
  }

  public var failureMessage: String? {
    if case .failed(let message, _) = self { return message }
    return nil
  }
}

public struct UpdateChecker: Sendable {
  public typealias PageLoader = @Sendable (URLRequest) async throws -> (Data, URLResponse)

  private struct Release: Decodable {
    let tagName: String
    let htmlURL: URL
    let draft: Bool
    let prerelease: Bool

    private enum CodingKeys: String, CodingKey {
      case tagName = "tag_name"
      case htmlURL = "html_url"
      case draft
      case prerelease
    }
  }

  private let loadPage: PageLoader

  public init(loadPage: PageLoader? = nil) {
    self.loadPage =
      loadPage ?? { request in
        try await URLSession.shared.data(for: request)
      }
  }

  public func latestUpdate(currentVersion: String) async throws -> AvailableUpdate? {
    guard let current = ReleaseVersion(tag: ReleaseVersion.tagPrefix + currentVersion) else {
      return nil
    }
    var available: [AvailableUpdate] = []
    var page = 1
    while true {
      let releases = try await releasePage(page, currentVersion: currentVersion)
      available.append(
        contentsOf: releases.compactMap { release in
          guard !release.draft,
            !release.prerelease,
            let version = ReleaseVersion(tag: release.tagName),
            version > current
          else {
            return nil
          }
          return AvailableUpdate(version: version, downloadURL: release.htmlURL)
        })
      if releases.count < 100 { break }
      page += 1
    }
    return available.max { $0.version < $1.version }
  }

  private func releasePage(_ page: Int, currentVersion: String) async throws -> [Release] {
    var components = URLComponents(string: "https://api.github.com/repos/open-gsd/gsd-pi/releases")
    components?.queryItems = [
      URLQueryItem(name: "per_page", value: "100"),
      URLQueryItem(name: "page", value: String(page)),
    ]
    guard let url = components?.url else { throw URLError(.badURL) }
    var request = URLRequest(url: url)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("GSDCloudMonitor/\(currentVersion)", forHTTPHeaderField: "User-Agent")
    let (data, response) = try await loadPage(request)
    guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
      throw URLError(.badServerResponse)
    }
    return try JSONDecoder().decode([Release].self, from: data)
  }
}
