// appicon <app path> <out.png> [size]  — writes the app's real macOS icon as a PNG (what the Dock shows).
import Cocoa

let a = CommandLine.arguments
guard a.count >= 3 else { FileHandle.standardError.write("usage: appicon <app> <out.png> [size]\n".data(using: .utf8)!); exit(2) }
let size = a.count > 3 ? Int(a[3]) ?? 128 : 128
let icon = NSWorkspace.shared.icon(forFile: a[1])
icon.size = NSSize(width: size, height: size)
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(3) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(4) }
do { try png.write(to: URL(fileURLWithPath: a[2])) } catch { exit(5) }
