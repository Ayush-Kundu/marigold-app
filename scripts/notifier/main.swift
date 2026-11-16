// Marigold Notifier — posts Marigold's notifications through Apple's UserNotifications framework
// (Electron 36 only speaks the old NSUserNotification API, which current macOS ignores).
//   MarigoldNotifier --title T --body B [--id ID] [--open marigold://…] [--group G]
// Clicking a notification opens its marigold:// link (Marigold then shows the chat / page).
import Cocoa
import UserNotifications

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let args = CommandLine.arguments
  func arg(_ k: String) -> String? {
    guard let i = args.firstIndex(of: k), i + 1 < args.count else { return nil }
    return args[i + 1]
  }
  func quit(after s: Double) { DispatchQueue.main.asyncAfter(deadline: .now() + s) { NSApp.terminate(nil) } }

  /// System sounds are looked up by name in ~/Library/Sounds, so copy the one we want there once.
  func soundNamed(_ n: String) -> UNNotificationSound? {
    if n == "none" || n.isEmpty { return nil }
    if n == "default" { return .default }
    let dir = NSHomeDirectory() + "/Library/Sounds", dst = "\(dir)/\(n).aiff", src = "/System/Library/Sounds/\(n).aiff"
    if !FileManager.default.fileExists(atPath: dst), FileManager.default.fileExists(atPath: src) {
      try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
      try? FileManager.default.copyItem(atPath: src, toPath: dst)
    }
    return FileManager.default.fileExists(atPath: dst) ? UNNotificationSound(named: UNNotificationSoundName("\(n).aiff")) : .default
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    // Buttons under the banner: open it, or quiet that kind of notification for an hour.
    let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])
    let snooze = UNNotificationAction(identifier: "snooze", title: "Quiet these for 1 hour", options: [])
    center.setNotificationCategories([UNNotificationCategory(identifier: "marigold.ping", actions: [open, snooze], intentIdentifiers: [], options: [])])
    if args.contains("--status") { // allowed | denied | not-asked
      center.getNotificationSettings { s in
        print(s.authorizationStatus == .authorized || s.authorizationStatus == .provisional ? "allowed" : s.authorizationStatus == .denied ? "denied" : "not-asked")
        exit(0)
      }
      return
    }
    guard let title = arg("--title") else { quit(after: 15); return } // launched by a click: wait for it, then quit
    center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      guard granted else { FileHandle.standardError.write("not-authorized\n".data(using: .utf8)!); exit(2) }
      let c = UNMutableNotificationContent()
      c.title = title
      c.body = self.arg("--body") ?? ""
      c.sound = self.soundNamed(self.arg("--sound") ?? "default")
      c.categoryIdentifier = "marigold.ping"
      var info: [String: String] = [:]
      if let o = self.arg("--open") { info["open"] = o }
      if let k = self.arg("--kind") { info["kind"] = k }
      c.userInfo = info
      if let g = self.arg("--group") { c.threadIdentifier = g }
      // Same id = replaces the earlier notification (e.g. a newer update about the same chat).
      let req = UNNotificationRequest(identifier: self.arg("--id") ?? UUID().uuidString, content: c, trigger: nil)
      center.add(req) { err in
        if let err = err { FileHandle.standardError.write("\(err)\n".data(using: .utf8)!); exit(3) }
        print("ok")
        self.quit(after: 2)
      }
    }
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let info = r.notification.request.content.userInfo
    if r.actionIdentifier == "snooze" {
      // Tell Marigold quietly (open -g: no window pops up).
      if let k = info["kind"] as? String {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-g", "marigold://mute?kind=\(k)&mins=60"]; try? p.run()
      }
    } else if let o = info["open"] as? String, let url = URL(string: o) { NSWorkspace.shared.open(url) }
    done()
    quit(after: 1)
  }
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .list, .sound])
  }
}

let app = NSApplication.shared
let delegate = Notifier()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
