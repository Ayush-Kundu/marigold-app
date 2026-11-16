// docread image <file> | docread pdf <file>  — what's in a picture or a PDF, read on this Mac (Apple Vision + PDFKit).
//   image → {"width":W,"height":H,"text":"…recognized text…","labels":[{"label":"dog","confidence":0.93}],"faces":N,"codes":["…"]}
//   pdf   → {"pages":N,"text":"…"}  (scanned pages are read with text recognition)
import Foundation
import Vision
import PDFKit
import AppKit

func out(_ o: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)!) }
let a = CommandLine.arguments
guard a.count >= 3 else { out(["error": "usage: docread image|pdf <file>"]); exit(2) }
let url = URL(fileURLWithPath: a[2])

func recognizeText(_ cg: CGImage) -> String {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  req.automaticallyDetectsLanguage = true
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  return lines.joined(separator: "\n")
}

if a[1] == "image" {
  guard let img = NSImage(contentsOf: url), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out(["error": "couldn't open that image"]); exit(0) }
  let classify = VNClassifyImageRequest()
  let faces = VNDetectFaceRectanglesRequest()
  let codes = VNDetectBarcodesRequest()
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([classify, faces, codes])
  let labels = (classify.results ?? []).filter { $0.confidence > 0.12 }.prefix(8).map { ["label": $0.identifier.replacingOccurrences(of: "_", with: " "), "confidence": Double(round($0.confidence * 100) / 100)] as [String: Any] }
  out(["width": cg.width, "height": cg.height, "text": String(recognizeText(cg).prefix(6000)),
       "labels": Array(labels), "faces": (faces.results ?? []).count,
       "codes": (codes.results ?? []).compactMap { $0.payloadStringValue }.prefix(5).map { $0 }])
} else if a[1] == "pdf" {
  guard let doc = PDFDocument(url: url) else { out(["error": "couldn't open that PDF"]); exit(0) }
  var text = (doc.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  if text.count < 40 { // scanned: read the first pages visually
    var parts: [String] = []
    for i in 0..<min(doc.pageCount, 6) {
      guard let page = doc.page(at: i) else { continue }
      let b = page.bounds(for: .mediaBox)
      let scale: CGFloat = 2
      let img = page.thumbnail(of: CGSize(width: b.width * scale, height: b.height * scale), for: .mediaBox)
      if let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) { parts.append(recognizeText(cg)) }
    }
    text = parts.joined(separator: "\n\n")
  }
  out(["pages": doc.pageCount, "text": String(text.prefix(14000))])
} else { out(["error": "unknown mode"]) }
