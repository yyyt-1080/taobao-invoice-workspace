import Foundation
import Vision

let path = CommandLine.arguments.dropFirst().first ?? ""
guard !path.isEmpty else { fputs("missing image path\n", stderr); exit(2) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
do {
    try VNImageRequestHandler(url: URL(fileURLWithPath: path)).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    print(text)
} catch {
    fputs("image OCR failed: \(error.localizedDescription)\n", stderr)
    exit(2)
}
