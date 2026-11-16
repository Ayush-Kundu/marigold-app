import CoreGraphics
import Foundation
// Usage: windows App1 App2 … → "windowID<TAB>app<TAB>w<TAB>h" for each app's on-screen normal windows, front-most first.
let want = Set(CommandLine.arguments.dropFirst().map { $0.lowercased() })
// All windows (incl. other Spaces / covered ones) — screencapture -l can still grab them. On-screen first.
let all = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let info = all.filter { ($0[kCGWindowIsOnscreen as String] as? Bool) == true } + all.filter { ($0[kCGWindowIsOnscreen as String] as? Bool) != true }
for w in info {
  if let a = w[kCGWindowAlpha as String] as? Double, a == 0 { continue }
  guard let owner = w[kCGWindowOwnerName as String] as? String, want.contains(owner.lowercased()),
        (w[kCGWindowLayer as String] as? Int) == 0,
        let id = w[kCGWindowNumber as String] as? Int,
        let b = w[kCGWindowBounds as String] as? [String: Double],
        let wd = b["Width"], let ht = b["Height"], wd > 120, ht > 80 else { continue }
  let name = (w[kCGWindowName as String] as? String) ?? ""
  print("\(id)\t\(owner)\t\(Int(wd))\t\(Int(ht))\t\(name)")
}
