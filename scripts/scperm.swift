// scperm → "yes" if this app may record the screen, else "no". Never shows a prompt.
import CoreGraphics
print(CGPreflightScreenCaptureAccess() ? "yes" : "no")
