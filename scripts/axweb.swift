// axweb — drive a web page through macOS Accessibility (like a screen reader does).
// Works in every browser (Chrome, Safari, Arc, Edge, Brave, Firefox, Opera…) and
// needs no "Allow JavaScript from Apple Events" setting — only the Accessibility
// permission Marigold already uses.
//
//   axweb list  <App>              → JSON {title,url,els:[{kind,label,vis}]}
//   axweb text  <App>              → JSON {title,url,text}
//   axweb info  <App> <index>      → JSON {kind,label}   (safety re-check before acting)
//   axweb press <App> <index>      → "ok <label>" | "NOELEM"
//   axweb focus <App> <index>      → "ok" | "NOELEM"
//   axweb scroll <App> up|down     → "ok"
//   axweb setvalue <App> <index> <text> → "ok" | "NOSET" | "NOELEM"   (types WITHOUT bringing the window forward)
//
// Elements are numbered in a stable depth-first order, so `list` → `press 7`
// hits the same element as long as the page hasn't changed.

import AppKit
import ApplicationServices
import Foundation

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String {
  if let s = attr(e, name) as? String { return s }
  return ""
}
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func frame(_ e: AXUIElement) -> CGRect {
  var p = CGPoint.zero, s = CGSize.zero
  if let v = attr(e, kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
  if let v = attr(e, kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &s) }
  return CGRect(origin: p, size: s)
}
func out(_ o: Any) {
  let d = try! JSONSerialization.data(withJSONObject: o)
  print(String(data: d, encoding: .utf8)!)
}

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: axweb list|text|info|press|focus <App> [index]"); exit(2) }
let cmd = args[1], appName = args[2]
let index = args.count > 3 ? Int(args[3]) ?? -1 : -1
// --url <address>: act on the tab showing exactly this page (whatever window it's in),
// never on "whatever happens to be in front".
var wantURL = ""
if let i = args.firstIndex(of: "--url"), i + 1 < args.count { wantURL = args[i + 1] }
func norm(_ u: String) -> String {
  var x = u
  if let h = x.firstIndex(of: "#") { x = String(x[..<h]) }
  while x.hasSuffix("/") { x.removeLast() }
  return x.lowercased()
}

guard let running = NSWorkspace.shared.runningApplications.first(where: {
  $0.localizedName?.lowercased() == appName.lowercased()
}) else { out(["error": "\(appName) isn't running"]); exit(0) }
let app = AXUIElementCreateApplication(running.processIdentifier)
// Chromium only builds the web-page tree when an assistive app asks for it.
AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)

func windows() -> [AXUIElement] {
  var list = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if let f = attr(app, kAXFocusedWindowAttribute) {
    let fw = f as! AXUIElement
    list.removeAll { CFEqual($0, fw) }
    list.insert(fw, at: 0) // focused window first
  }
  return list
}

func urlOf(_ e: AXUIElement) -> String {
  guard let u = attr(e, "AXURL") else { return "" }
  return (u as? URL)?.absoluteString ?? "\(u)"
}

var pageWindow: AXUIElement?

/// The page to act on: with --url, the web area showing that address in ANY window;
/// otherwise the biggest web area in the focused window.
func webArea() -> AXUIElement? {
  for w in windows() {
    if let p = webAreaIn(w), wantURL.isEmpty || norm(urlOf(p)) == norm(wantURL) { pageWindow = w; return p }
  }
  return nil
}

func webAreaIn(_ w: AXUIElement) -> AXUIElement? {
  var best: AXUIElement?, bestArea: CGFloat = 0
  var queue: [(AXUIElement, Int)] = [(w, 0)]
  var seen = 0
  while !queue.isEmpty && seen < 4000 {
    let (e, d) = queue.removeFirst(); seen += 1
    if str(e, kAXRoleAttribute) == "AXWebArea" {
      let f = frame(e); let a = f.width * f.height
      if a > bestArea { best = e; bestArea = a }
      continue // don't search inside a page for another page
    }
    if d < 25 { queue.append(contentsOf: kids(e).map { ($0, d + 1) }) }
  }
  return best
}

let INTERACTIVE: [String: String] = [
  "AXButton": "button", "AXLink": "a", "AXTextField": "input:text", "AXTextArea": "textarea",
  "AXCheckBox": "input:checkbox", "AXRadioButton": "input:radio", "AXPopUpButton": "select",
  "AXComboBox": "input:combobox", "AXMenuItem": "menuitem", "AXMenuButton": "button", "AXTab": "tab",
  "AXSlider": "slider", "AXDisclosureTriangle": "summary", "AXSearchField": "input:search",
]
// Don't look inside these — their children are just their label text.
let LEAF: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab", "AXSlider", "AXComboBox"]

func innerText(_ e: AXUIElement, _ depth: Int = 0) -> String {
  if depth > 4 { return "" }
  var parts: [String] = []
  for k in kids(e) {
    if str(k, kAXRoleAttribute) == "AXStaticText" { parts.append(str(k, kAXValueAttribute)) }
    else { parts.append(innerText(k, depth + 1)) }
    if parts.joined().count > 80 { break }
  }
  return parts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
}

func label(_ e: AXUIElement, role: String) -> String {
  var l = ""
  for a in [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute] {
    l = str(e, a).trimmingCharacters(in: .whitespacesAndNewlines)
    if !l.isEmpty { break }
  }
  if l.isEmpty && (role == "AXButton" || role == "AXLink" || role == "AXMenuItem" || role == "AXTab") { l = innerText(e) }
  if l.isEmpty && role != "AXTextField" && role != "AXTextArea" { l = str(e, kAXValueAttribute) }
  let squashed = l.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
  return String(squashed.prefix(80))
}

struct Item { let el: AXUIElement; let kind: String; let label: String; let vis: Bool }

func collect(_ root: AXUIElement) -> [Item] {
  let view = frame(root)
  var items: [Item] = []
  var visited = 0
  let deadline = Date().addingTimeInterval(6)
  func walk(_ e: AXUIElement, _ depth: Int) {
    if items.count >= 300 || visited > 12000 || depth > 80 || Date() > deadline { return }
    visited += 1
    let role = str(e, kAXRoleAttribute)
    if var kind = INTERACTIVE[role] {
      let f = frame(e)
      if f.width > 1 && f.height > 1 {
        if str(e, kAXSubroleAttribute) == "AXSecureTextField" { kind = "input:password" }
        if role == "AXTextArea" || (role == "AXTextField" && (attr(e, "AXEditableAncestor") != nil)) { /* editable */ }
        items.append(Item(el: e, kind: kind, label: label(e, role: role), vis: f.intersects(view)))
      }
      if LEAF.contains(role) { return }
    }
    for k in kids(e) { walk(k, depth + 1) }
  }
  walk(root, 0)
  return items
}

guard let page = webArea() else {
  if wantURL.isEmpty { out(["error": "No web page found in \(appName) (is a window open?)"]) }
  else { out(["error": "The tab with \(wantURL) isn't showing anymore (it was closed, or another tab is active in its window). Call elements again."]) }
  exit(0)
}
let pageTitle = str(page, kAXTitleAttribute)
let pageURL = urlOf(page)

/// Bring the page's window to the front so keystrokes land in THIS page, then verify.
func raise() -> Bool {
  guard let w = pageWindow else { return false }
  running.activate()
  AXUIElementPerformAction(w, kAXRaiseAction as CFString)
  AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
  usleep(300_000)
  if let f = attr(app, kAXFocusedWindowAttribute) { return CFEqual(f as! AXUIElement, w) }
  return false
}

switch cmd {
case "scroll":
  if !raise() { print("NOFRONT"); exit(0) }
  let f = frame(page)
  let up = args.count > 3 && args[3].lowercased().hasPrefix("u")
  let pt = CGPoint(x: f.midX, y: f.midY)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
  for _ in 0..<8 {
    let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(up ? 80 : -80), wheel2: 0, wheel3: 0)
    ev?.location = pt
    ev?.post(tap: .cghidEventTap)
    usleep(15_000)
  }
  print("ok")
case "list":
  let items = collect(page)
  out(["title": pageTitle, "url": pageURL,
       "els": items.map { ["kind": $0.kind, "label": $0.label, "vis": $0.vis, "ac": ""] as [String: Any] }])
case "frontcheck":
  // Is this page's window the one in front (so keystrokes would land here)?
  print(raise() ? "ok" : "NOFRONT")
case "text":
  var parts: [String] = [], n = 0
  func walk(_ e: AXUIElement, _ d: Int) {
    if n > 30000 || d > 80 { return }
    let r = str(e, kAXRoleAttribute)
    if r == "AXStaticText" { let v = str(e, kAXValueAttribute); parts.append(v); n += v.count; return }
    if r == "AXHeading" || r == "AXGroup" && d < 3 { parts.append("\n") }
    for k in kids(e) { walk(k, d + 1) }
  }
  walk(page, 0)
  out(["title": pageTitle, "url": pageURL, "text": parts.joined(separator: " ")])
case "setvalue":
  // Fill a field in the background: set its value through Accessibility and read it back.
  // No window raise, no keystrokes — the user can keep working in other apps/tabs.
  let items = collect(page)
  guard index >= 0 && index < items.count else { print("NOELEM"); exit(0) }
  let el = items[index].el
  let text = args.count > 4 ? args[4] : ""
  AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  let r = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFString)
  usleep(120_000)
  print(r == .success && str(el, kAXValueAttribute) == text ? "ok" : "NOSET")
case "info", "press", "focus":
  let items = collect(page)
  guard index >= 0 && index < items.count else { print("NOELEM"); exit(0) }
  let it = items[index]
  if cmd == "info" { out(["kind": it.kind, "label": it.label, "url": pageURL, "value": str(it.el, kAXValueAttribute)]); exit(0) }
  if cmd == "focus" {
    // Keystrokes go to the front window — refuse unless THIS page's window is in front.
    if !raise() { print("NOFRONT"); exit(0) }
    AXUIElementSetAttributeValue(it.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(150_000)
    let focused = (attr(it.el, kAXFocusedAttribute) as? Bool) ?? false
    print(focused ? "ok" : "NOFOCUS"); exit(0)
  }
  // press: bring the page's window forward first (Chrome ignores clicks in windows it
  // isn't drawing), then the accessibility "click"; fall back to a real mouse click.
  // Safari-family browsers accept accessibility clicks in background windows; Chromium/Firefox
  // only act on windows they're drawing, so raise those first.
  let background = ["safari", "orion"].contains(appName.lowercased())
  if !background { _ = raise() }
  if AXUIElementPerformAction(it.el, kAXPressAction as CFString) == .success {
    print("ok \(it.label)")
  } else {
    if !raise() { print("NOFRONT"); exit(0) }
    let f = frame(it.el)
    let pt = CGPoint(x: f.midX, y: f.midY)
    for t in [CGEventType.leftMouseDown, .leftMouseUp] {
      CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
      usleep(60_000)
    }
    print("ok \(it.label)")
  }
default:
  print("unknown command \(cmd)")
}
