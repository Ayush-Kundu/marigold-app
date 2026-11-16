// appctl — lets the user operate an app THROUGH the View tab's live picture, without
// bringing the real window forward (so Marigold's View is never covered).
//
//   appctl click  <App> <windowID> <nx> <ny>      → press/focus whatever is at that spot (0..1 coords)
//   appctl scroll <App> <windowID> <nx> <ny> <dy> → scroll there (dy > 0 = up)
//   appctl type   <App> <text>                    → type into the app's focused field (background)
//   appctl key    <App> <keyName>                 → enter, tab, escape, backspace, up, down, left, right, space
//   appctl fit    <App> <windowID> <aspect>       → resize the window to this width/height ratio (View fills edge to edge)
//   appctl enter  <App> <windowID>                → bring the window forward in full screen for direct use
//   appctl front  <App>                           → "yes" if the app is frontmost
//
// Clicks are resolved with Accessibility (deepest element under the point in THAT window),
// which works even when the window is behind other windows.

import AppKit
import ApplicationServices
import Foundation

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

func attr(_ e: AXUIElement, _ n: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ n: String) -> String { (attr(e, n) as? String) ?? "" }
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

let a = CommandLine.arguments
guard a.count >= 3 else { print("usage: appctl click|scroll|type|key|fit|enter|front <App> …"); exit(2) }
let cmd = a[1], appName = a[2]
guard let running = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName?.lowercased() == appName.lowercased() }) else {
  print("ERR \(appName) isn't running"); exit(0)
}
let pid = running.processIdentifier
let app = AXUIElementCreateApplication(pid)
AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)

func window(_ wid: String) -> AXUIElement? {
  let want = CGWindowID(UInt32(wid) ?? 0)
  for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
    var id: CGWindowID = 0
    if _AXUIElementGetWindow(w, &id) == .success, id == want { return w }
  }
  return nil
}

/// Deepest element containing the point (later siblings are drawn on top, so search them first).
func hit(_ e: AXUIElement, _ p: CGPoint, _ depth: Int = 0) -> AXUIElement? {
  if depth > 60 { return nil }
  for k in kids(e).reversed() {
    let f = frame(k)
    if f.width > 0 && f.height > 0 && f.contains(p), let h = hit(k, p, depth + 1) { return h }
  }
  return frame(e).contains(p) ? e : nil
}

/// Window bounds from the window server (works for windows on ANY desktop, unlike Accessibility).
func cgBounds(_ wid: String) -> CGRect? {
  guard let id = UInt32(wid),
        let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(id)) as? [[String: Any]])?.first,
        let b = info[kCGWindowBounds as String] as? [String: Double] else { return nil }
  return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
}

func keyCode(_ name: String) -> CGKeyCode? {
  let m: [String: CGKeyCode] = ["enter": 36, "return": 36, "tab": 48, "escape": 53, "esc": 53, "backspace": 51,
                                "delete": 117, "up": 126, "down": 125, "left": 123, "right": 124, "space": 49,
                                "pageup": 116, "pagedown": 121, "home": 115, "end": 119]
  return m[name.lowercased()]
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
  for down in [true, false] {
    let ev = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    ev?.flags = flags
    ev?.postToPid(pid)
    usleep(8_000)
  }
}

/// A real mouse click delivered straight to the app's process and window (the window id is stamped on the events),
/// so it works for apps whose controls Accessibility can't press, and without bringing the app to the front.
func postMouse(_ p: CGPoint, wid: UInt32, clicks: Int = 1) {
  func stamp(_ ev: CGEvent?) {
    ev?.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(wid))  // window under the pointer
    ev?.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(wid))  // …that can handle this event
  }
  let mv = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)
  stamp(mv); mv?.postToPid(pid); usleep(15_000)
  for n in 1...max(1, clicks) {
    for t in [CGEventType.leftMouseDown, .leftMouseUp] {
      let ev = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)
      ev?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      stamp(ev); ev?.postToPid(pid); usleep(25_000)
    }
  }
}

switch cmd {
case "front":
  print(NSWorkspace.shared.frontmostApplication?.processIdentifier == pid ? "yes" : "no")

case "click", "scroll":
  guard a.count >= 6, let nx = Double(a[4]), let ny = Double(a[5]) else { print("ERR bad args"); exit(0) }
  // Accessibility only sees windows on the CURRENT desktop; the window server sees all of them. Use Accessibility when it can
  // see the window (best: it can press controls and focus fields), and the window server's bounds + real mouse events otherwise.
  guard let cg = cgBounds(a[3]) else { print("ERR window gone"); exit(0) }
  let ax = window(a[3])
  let f = ax.map { frame($0) } ?? cg
  let p = CGPoint(x: f.minX + CGFloat(nx) * f.width, y: f.minY + CGFloat(ny) * f.height)
  if cmd == "scroll" {
    let dy = Int32(a.count > 6 ? Int(a[6]) ?? -120 : -120)
    let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)
    ev?.location = p
    if let id = UInt32(a[3]) { ev?.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(id)); ev?.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(id)) }
    ev?.postToPid(pid)
    print("ok"); exit(0)
  }
  // Walk up from the deepest element to the first thing that can be pressed or typed into.
  var el = ax.flatMap { hit($0, p) }
  var steps = 0
  while ax != nil, let e = el, steps < 8 {
    let role = str(e, kAXRoleAttribute)
    if ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) || str(e, kAXSubroleAttribute) == "AXSearchField" {
      AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      print("ok focused \(role)"); exit(0)
    }
    if actions(e).contains(kAXPressAction) {
      AXUIElementPerformAction(e, kAXPressAction as CFString)
      print("ok pressed \(str(e, kAXTitleAttribute).isEmpty ? role : str(e, kAXTitleAttribute))"); exit(0)
    }
    el = attr(e, kAXParentAttribute).map { $0 as! AXUIElement }
    steps += 1
  }
  // Nothing Accessibility can press (SwiftUI buttons, canvases, games…): click there for real.
  if ax != nil {
    // Same desktop: bring the app forward for an instant, click with the real pointer, then put the user's pointer and
    // front app (Marigold) straight back. (macOS only delivers such clicks to the front window.)
    let prev = NSWorkspace.shared.frontmostApplication
    running.activate()
    if let w = ax { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
    usleep(140_000)
    let back = CGEvent(source: nil)?.location ?? .zero
    for t in [CGEventType.leftMouseDown, .leftMouseUp] {
      CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
      usleep(45_000)
    }
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: back, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(60_000)
    if let prev = prev, prev.processIdentifier != pid { prev.activate() }
  } else if let id = UInt32(a[3]) { postMouse(p, wid: id) } // another desktop: best effort
  print("ok clicked")

case "type":
  let text = a.count > 3 ? a[3] : ""
  // Unicode chunks straight to the app's process — works while it's in the background.
  var chars = Array(text.utf16)
  while !chars.isEmpty {
    let chunk = Array(chars.prefix(16)); chars.removeFirst(min(16, chars.count))
    for down in [true, false] {
      let ev = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
      ev?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      ev?.postToPid(pid)
    }
    usleep(10_000)
  }
  print("ok")

case "key":
  guard a.count >= 4, let code = keyCode(a[3]) else { print("ERR unknown key"); exit(0) }
  postKey(code)
  print("ok")

case "realclick":
  // Last-resort click for apps with no Accessibility buttons (found by on-screen text):
  // bring the window forward, click, then put the user's pointer back where it was.
  guard a.count >= 6, let nx = Double(a[4]), let ny = Double(a[5]), let b = cgBounds(a[3]) else { print("ERR bad args"); exit(0) }
  running.activate()
  if let w = window(a[3]) { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
  usleep(350_000)
  let back = CGEvent(source: nil)?.location ?? .zero
  let p = CGPoint(x: b.minX + CGFloat(nx) * b.width, y: b.minY + CGFloat(ny) * b.height)
  for t in [CGEventType.leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(50_000)
  }
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: back, mouseButton: .left)?.post(tap: .cghidEventTap)
  print("ok")

case "fit":
  guard a.count >= 5, let aspect = Double(a[4]), aspect > 0.2, aspect < 6 else { print("ERR bad args"); exit(0) }
  guard let w = window(a[3]) else { print("ERR otherspace"); exit(0) }
  if (attr(w, "AXFullScreen") as? Bool) == true { print("ok fullscreen"); exit(0) }
  let screen = NSScreen.screens.first { $0.frame.contains(frame(w).origin) } ?? NSScreen.main!
  let vis = screen.visibleFrame
  var f = frame(w)
  // Same overall area as now (at least ~1000×640), just reshaped to the View's proportions.
  let area = max(f.width * f.height, 1000 * 640)
  var width = (area * CGFloat(aspect)).squareRoot(), height = width / CGFloat(aspect)
  if height > vis.height - 20 { height = vis.height - 20; width = height * CGFloat(aspect) }
  if width > vis.width - 20 { width = vis.width - 20; height = width / CGFloat(aspect) }
  if abs(f.width - width) < 4 && abs(f.height - height) < 4 { print("ok same"); exit(0) }
  var size = CGSize(width: width, height: height)
  AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
  // Keep it on screen.
  f = frame(w)
  let topY = NSScreen.screens[0].frame.height - vis.maxY // AX uses top-left origin
  var pos = CGPoint(x: min(max(f.minX, vis.minX), vis.maxX - f.width), y: max(f.minY, topY))
  AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pos)!)
  print("ok \(Int(width))x\(Int(height))")

case "tile":
  // tile <App> <windowID> x y w h — put the window exactly there (screen points, top-left origin) and bring it forward.
  guard a.count >= 8, let x = Double(a[4]), let y = Double(a[5]), let w0 = Double(a[6]), let h0 = Double(a[7]) else { print("ERR bad args"); exit(0) }
  guard let w = window(a[3]) else { print("ERR otherspace"); exit(0) }
  if (attr(w, "AXFullScreen") as? Bool) == true { AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, kCFBooleanFalse); usleep(900_000) }
  if (attr(w, "AXMinimized") as? Bool) == true { AXUIElementSetAttributeValue(w, "AXMinimized" as CFString, kCFBooleanFalse) }
  var pos = CGPoint(x: x, y: y), size = CGSize(width: w0, height: h0)
  AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
  AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pos)!)
  AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!) // again: moving across screens can clamp the size
  AXUIElementPerformAction(w, kAXRaiseAction as CFString)
  running.activate()
  let f = frame(w)
  print("ok \(Int(f.width))x\(Int(f.height))")

case "enter":
  guard a.count >= 4 else { print("ERR bad args"); exit(0) }
  // Switch to the app first — if its window is on another desktop, macOS goes there,
  // and only then does Accessibility see the window.
  running.activate()
  var found = window(a[3])
  for _ in 0..<10 where found == nil { usleep(200_000); found = window(a[3]) }
  guard let w = found else { print("ok activated"); exit(0) }
  AXUIElementPerformAction(w, kAXRaiseAction as CFString)
  AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
  usleep(300_000)
  AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, kCFBooleanTrue)
  print("ok")

default:
  print("ERR unknown command")
}
