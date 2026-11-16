// brightness get | set <0-100> | up | down — built-in display brightness (the same
// control the keyboard's brightness keys use).
import CoreGraphics
import Foundation
typealias GetFn = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
typealias SetFn = @convention(c) (UInt32, Float) -> Int32
guard let h = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_NOW),
      let g = dlsym(h, "DisplayServicesGetBrightness"), let s = dlsym(h, "DisplayServicesSetBrightness") else { print("ERR no display control"); exit(0) }
let getB = unsafeBitCast(g, to: GetFn.self), setB = unsafeBitCast(s, to: SetFn.self)
let d = CGMainDisplayID()
var cur: Float = 0
guard getB(d, &cur) == 0 else { print("ERR this display's brightness can't be read (external monitor?)"); exit(0) }
let a = CommandLine.arguments
let cmd = a.count > 1 ? a[1] : "get"
var target = cur
switch cmd {
case "set": target = (Float(a.count > 2 ? a[2] : "") ?? cur * 100) / 100
case "up": target = cur + 0.1
case "down": target = cur - 0.1
default: print(Int((cur * 100).rounded())); exit(0)
}
target = min(1, max(0, target))
print(setB(d, target) == 0 ? "\(Int((target * 100).rounded()))" : "ERR couldn't set brightness")
