import Foundation
import PDFKit

guard CommandLine.arguments.count == 2 else { fputs("missing PDF path\n", stderr); exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: url), !document.isLocked, document.pageCount > 0, document.pageCount <= 20, let text = document.string, !text.isEmpty else {
    fputs("PDF text unavailable\n", stderr)
    exit(2)
}
FileHandle.standardOutput.write(Data(text.utf8))
