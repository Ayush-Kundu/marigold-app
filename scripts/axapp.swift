// axapp — operate ANY Mac app through Accessibility (buttons, fields, lists, menus).
//
//   axapp elements <App>            → JSON {window, els:[{kind,label,value,vis}]}  (front window + open sheets/dialogs)
//   axapp read     <App>            → JSON {window, text}
//   axapp info     <App> <i>        → JSON {kind,label,value}
//   axapp press    <App> <i>        → "ok <label>" | "NOELEM"
//   axapp setvalue <App> <i> <text> → "ok" | "NOSET" | "NOELEM"
//   axapp focus    <App> <i>        → "ok" | "NOELEM"
//   axapp menus    <App>            → JSON {menus:[{menu, items:[…]}]}   (what the app can do)
//   axapp menu     <App> <A>B>C>    → "ok <path>" | "ERR …"                (click a menu command)
//
// Elements are numbered in a stable order, so `elements` → `press 7` hits the same
// thing as long as the window hasn't changed. Only windows on the current desktop.

import AppKit
import ApplicationServices
import Foundation

func attr(_ e: AXUIElement, _ n: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ n: String) -> String {
  if let s = attr(e, n) as? String { return s }
  if let n = attr(e, n) as? NSNumber { return n.stringValue }
  return ""
}
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func frame(_ e: AXUIElement) -> CGRect {
  var p = CGPoint.zero, s = CGSize.zero
  if let v = attr(e, kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
  if let v = attr(e, kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &s) }
  return CGRect(origin: p, size: s)
}
func actions(_ e: AXUIElement) -> [String] {
  var names: CFArray?
  AXUIElementCopyActionNames(e, &names)
  return (names as? [String]) ?? []
}
func out(_ o: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)!) }
func squash(_ s: String, _ n: Int = 90) -> String {
  String(s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ").prefix(n))
}

let a = CommandLine.arguments
guard a.count >= 3 else { print("usage: axapp elements|read|info|press|setvalue|focus|menus|menu <App> …"); exit(2) }
let cmd = a[1], appName = a[2]
// Without Accessibility permission macOS hides every window — say so instead of "no window".
if !AXIsProcessTrusted() {
  out(["error": "Marigold doesn't have Accessibility permission, so it can't see or control other apps. Tell the user: System Settings → Privacy & Security → Accessibility → turn on Marigold (then quit and reopen Marigold)."])
  exit(0)
}
guard let running = NSWorkspace.shared.runningApplications.first(where: {
  $0.localizedName?.lowercased() == appName.lowercased() || $0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == appName.lowercased()
}) else { out(["error": "\(appName) isn't open — open it first"]); exit(0) }
let app = AXUIElementCreateApplication(running.processIdentifier)
AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) // Electron/Chromium apps

// ---------------------------------------------------------------- menus (work even with no window)

func menuBar() -> AXUIElement? { attr(app, kAXMenuBarAttribute).map { $0 as! AXUIElement } }
func norm(_ s: String) -> String { s.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces) }

func menuItems(_ menuOwner: AXUIElement) -> [AXUIElement] {
  // A menu-bar item / menu item has one child: its AXMenu, whose children are the items.
  guard let menu = kids(menuOwner).first(where: { str($0, kAXRoleAttribute) == "AXMenu" }) else { return [] }
  return kids(menu)
}

if cmd == "menus" {
  guard let bar = menuBar() else { out(["error": "no menu bar"]); exit(0) }
  var menus: [[String: Any]] = []
  for top in kids(bar).dropFirst() { // skip the Apple menu
    let title = str(top, kAXTitleAttribute)
    var items: [String] = []
    for it in menuItems(top) {
      let t = str(it, kAXTitleAttribute)
      if t.isEmpty { continue }
      let sub = menuItems(it).map { str($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
      let enabled = (attr(it, kAXEnabledAttribute) as? Bool) ?? true
      items.append(sub.isEmpty ? (enabled ? t : "\(t) (disabled)") : "\(t) > [\(sub.prefix(12).joined(separator: ", "))]")
      if items.count > 40 { break }
    }
    menus.append(["menu": title, "items": items])
  }
  out(["menus": menus]); exit(0)
}

if cmd == "menu" {
  guard a.count >= 4, let bar = menuBar() else { print("ERR no menu bar"); exit(0) }
  let path = a[3].split(separator: ">").map { norm(String($0)) }.filter { !$0.isEmpty }
  var level = kids(bar).dropFirst().map { $0 }
  var picked: AXUIElement?
  for (i, want) in path.enumerated() {
    guard let hit = level.first(where: { norm(str($0, kAXTitleAttribute)) == want }) ?? level.first(where: { norm(str($0, kAXTitleAttribute)).hasPrefix(want) })
    else { print("ERR no menu item “\(want)” — call menus to see the names"); exit(0) }
    picked = hit
    if i < path.count - 1 { level = menuItems(hit) }
  }
  guard let item = picked else { print("ERR empty path"); exit(0) }
  if (attr(item, kAXEnabledAttribute) as? Bool) == false { print("ERR that menu item is disabled right now"); exit(0) }
  AXUIElementPerformAction(item, kAXPressAction as CFString)
  print("ok \(path.joined(separator: " > "))"); exit(0)
}

// ---------------------------------------------------------------- window content

func windowsToScan() -> [AXUIElement] {
  var list: [AXUIElement] = []
  if let f = attr(app, kAXFocusedWindowAttribute) { list.append(f as! AXUIElement) }
  for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] where !list.contains(where: { CFEqual($0, w) }) {
    let sub = str(w, kAXSubroleAttribute)
    if sub == "AXDialog" || sub == "AXSystemDialog" || list.isEmpty { list.append(w) } // dialogs + a fallback main window
  }
  return list
}

let INTERACTIVE: [String: String] = [
  "AXButton": "button", "AXLink": "link", "AXTextField": "field", "AXTextArea": "text area", "AXSearchField": "search",
  "AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXPopUpButton": "popup", "AXComboBox": "combo",
  "AXMenuButton": "menu button", "AXTab": "tab", "AXSlider": "slider", "AXDisclosureTriangle": "disclosure",
  "AXRow": "row", "AXCell": "cell", "AXSwitch": "switch", "AXIncrementor": "stepper", "AXColorWell": "color",
]
let LEAF: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab", "AXSlider", "AXComboBox", "AXSearchField", "AXSwitch"]

func innerText(_ e: AXUIElement, _ d: Int = 0) -> String {
  if d > 5 { return "" }
  var parts: [String] = []
  for k in kids(e) {
    let r = str(k, kAXRoleAttribute)
    if r == "AXStaticText" || r == "AXTextField" { parts.append(str(k, kAXValueAttribute)) } else { parts.append(innerText(k, d + 1)) }
    if parts.joined().count > 90 { break }
  }
  return squash(parts.joined(separator: " "))
}

func label(_ e: AXUIElement, _ role: String) -> String {
  for n in [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute] {
    let v = squash(str(e, n))
    if !v.isEmpty { return v }
  }
  if ["AXRow", "AXCell", "AXButton", "AXLink", "AXTab", "AXMenuButton"].contains(role) { return innerText(e) }
  return ""
}

struct Item { let el: AXUIElement; let kind: String; let label: String; let value: String; let vis: Bool }

func collect() -> (String, [Item]) {
  var items: [Item] = []
  var title = ""
  var visited = 0
  let deadline = Date().addingTimeInterval(6)
  for w in windowsToScan() {
    if title.isEmpty { title = str(w, kAXTitleAttribute) }
    let view = frame(w)
    func walk(_ e: AXUIElement, _ depth: Int) {
      if items.count >= 220 || visited > 15000 || depth > 60 || Date() > deadline { return }
      visited += 1
      let role = str(e, kAXRoleAttribute)
      if let kind = INTERACTIVE[role] {
        let f = frame(e)
        if f.width > 1 && f.height > 1 {
          let sub = str(e, kAXSubroleAttribute)
          let k = sub == "AXSecureTextField" ? "password" : kind
          let l = label(e, role)
          let v = role == "AXRow" || role == "AXCell" || sub == "AXSecureTextField" ? "" : squash(str(e, kAXValueAttribute), 60)
          // Skip anonymous rows/cells with no text (layout noise) and floods of identical badges.
          let dupes = items.filter { $0.kind == k && $0.label == l && $0.value == v }.count
          if !(l.isEmpty && v.isEmpty && (role == "AXRow" || role == "AXCell")) && dupes < 2 {
            items.append(Item(el: e, kind: k, label: l, value: v, vis: f.intersects(view)))
          }
        }
        if LEAF.contains(role) || role == "AXRow" { return }
      }
      for k in kids(e) { walk(k, depth + 1) }
    }
    walk(w, 0)
  }
  return (title, items)
}

switch cmd {
case "elements":
  let (title, items) = collect()
  if items.isEmpty && windowsToScan().isEmpty { out(["error": "\(appName) has no window open on this desktop — use its menus, or open a window first"]); exit(0) }
  out(["window": title, "els": items.map { ["kind": $0.kind, "label": $0.label, "value": $0.value, "vis": $0.vis] as [String: Any] }])
case "read":
  var parts: [String] = []
  var n = 0
  var title = ""
  for w in windowsToScan() {
    if title.isEmpty { title = str(w, kAXTitleAttribute) }
    func walk(_ e: AXUIElement, _ d: Int) {
      if n > 20000 || d > 60 { return }
      let r = str(e, kAXRoleAttribute)
      if r == "AXStaticText" || r == "AXTextArea" || (r == "AXTextField" && str(e, kAXSubroleAttribute) != "AXSecureTextField") {
        let v = str(e, kAXValueAttribute)
        if !v.isEmpty { parts.append(v); n += v.count }
        if r != "AXStaticText" { return }
      }
      for k in kids(e) { walk(k, d + 1) }
    }
    walk(w, 0)
  }
  out(["window": title, "text": parts.joined(separator: "\n")])
case "info", "press", "focus", "setvalue":
  let (_, items) = collect()
  let i = a.count > 3 ? Int(a[3]) ?? -1 : -1
  guard i >= 0 && i < items.count else { print("NOELEM"); exit(0) }
  let it = items[i]
  switch cmd {
  case "info": out(["kind": it.kind, "label": it.label, "value": it.value])
  case "focus":
    AXUIElementSetAttributeValue(it.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    print("ok")
  case "setvalue":
    let text = a.count > 4 ? a[4] : ""
    AXUIElementSetAttributeValue(it.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let r = AXUIElementSetAttributeValue(it.el, kAXValueAttribute as CFString, text as CFString)
    usleep(120_000)
    print(r == .success && str(it.el, kAXValueAttribute) == text ? "ok" : "NOSET")
  default: // press
    if actions(it.el).contains(kAXPressAction) {
      AXUIElementPerformAction(it.el, kAXPressAction as CFString)
    } else if it.kind == "row" || it.kind == "cell" {
      AXUIElementSetAttributeValue(it.el, kAXSelectedAttribute as CFString, kCFBooleanTrue) // select a list row
    } else {
      AXUIElementPerformAction(it.el, "AXPick" as CFString)
    }
    print("ok \(it.label)")
  }
default:
  print("unknown command \(cmd)")
}
