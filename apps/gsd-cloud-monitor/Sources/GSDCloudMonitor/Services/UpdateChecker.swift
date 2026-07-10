import Foundation
import GSDCloudMonitorCore

struct AvailableUpdate: Equatable {
  let version: ReleaseVersion
  let downloadURL: URL
}

struct UpdateChecker {
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

  func latestUpdate(currentVersion: String) async throws -> AvailableUpdate? {
    guard let current = ReleaseVersion(tag: ReleaseVersion.tagPrefix + currentVersion) else {
      return nil
    }
    guard let url = URL(string: "https://api.github.com/repos/open-gsd/gsd-pi/releases?per_page=30") else {
      throw URLError(.badURL)
    }
    var request = URLRequest(url: url)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("GSDCloudMonitor/\(currentVersion)", forHTTPHeaderField: "User-Agent")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
      throw URLError(.badServerResponse)
    }
    let releases = try JSONDecoder().decode([Release].self, from: data)
    return releases
      .filter { !$0.draft && !$0.prerelease }
      .compactMap { release -> AvailableUpdate? in
        guard let version = ReleaseVersion(tag: release.tagName), version > current else { return nil }
        return AvailableUpdate(version: version, downloadURL: release.htmlURL)
      }
      .max { $0.version < $1.version }
  }
}
