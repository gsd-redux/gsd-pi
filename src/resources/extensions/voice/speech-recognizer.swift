import Foundation
import Speech
import AVFoundation

// Unbuffered stdout
setbuf(stdout, nil)

guard SFSpeechRecognizer.authorizationStatus() == .authorized ||
      SFSpeechRecognizer.authorizationStatus() == .notDetermined else {
    print("ERROR:Speech recognition not authorized")
    exit(1)
}

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        print("ERROR:Speech recognition denied")
        exit(1)
    }
}

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
guard recognizer.isAvailable else {
    print("ERROR:Speech recognizer not available")
    exit(1)
}

let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = true

let node = audioEngine.inputNode
let format = node.outputFormat(forBus: 0)

node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
}

audioEngine.prepare()
do {
    try audioEngine.start()
    print("READY")
} catch {
    print("ERROR:Failed to start audio engine: \(error.localizedDescription)")
    exit(1)
}

// Accumulated finalized text from previous recognition segments.
// On-device recognition (especially macOS/iOS 18+) can reset
// bestTranscription.formattedString after a pause, discarding
// previous text. We detect this by tracking the last known good
// text and noticing when the new text is shorter / doesn't start
// with the previous text. When that happens we treat the previous
// text as finalized and start accumulating the new segment on top.
var accumulated = ""
var lastPartialText = ""
var lastEmitted = ""

recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        let text = result.bestTranscription.formattedString

        if result.isFinal {
            // True final from the recognizer — commit everything
            let full: String
            // Check if the final text already includes accumulated content
            // (some OS versions give cumulative finals, others reset)
            if !accumulated.isEmpty && !text.lowercased().hasPrefix(accumulated.lowercased()) {
                full = accumulated + " " + text
            } else if !accumulated.isEmpty && text.count < accumulated.count {
                // Final is shorter than what we accumulated — use accumulated + new
                full = accumulated + " " + text
            } else {
                full = text
            }
            accumulated = ""
            lastPartialText = ""
            if full != lastEmitted {
                lastEmitted = full
                print("FINAL:\(full)")
            }
            return
        }

        // Detect transcription reset: if the new partial text is significantly
        // shorter than what we had, or doesn't start with the previous text,
        // the recognizer has reset after a pause. Finalize what we had.
        let prevText = lastPartialText
        if !prevText.isEmpty && !text.isEmpty {
            let prevWords = prevText.split(separator: " ")
            let newWords = text.split(separator: " ")

            // Reset detection: new text has fewer words than previous AND
            // the first few words don't match (i.e. it's truly new speech,
            // not just the recognizer revising the last word)
            let looksLikeReset: Bool
            if newWords.count < prevWords.count / 2 {
                // Significant drop in word count — likely a reset
                looksLikeReset = true
            } else if newWords.count < prevWords.count &&
                      !prevWords.isEmpty && !newWords.isEmpty &&
                      newWords[0] != prevWords[0] {
                // Different starting word + fewer words — reset
                looksLikeReset = true
            } else {
                looksLikeReset = false
            }

            if looksLikeReset {
                // Commit the previous partial text to accumulated
                if accumulated.isEmpty {
                    accumulated = prevText
                } else {
                    accumulated = accumulated + " " + prevText
                }
                // Emit a FINAL for the committed text so the TS side updates
                print("FINAL:\(accumulated)")
                lastEmitted = accumulated
            }
        }

        lastPartialText = text

        // Build the full display text
        let displayText: String
        if accumulated.isEmpty {
            displayText = text
        } else {
            displayText = accumulated + " " + text
        }

        if displayText != lastEmitted {
            lastEmitted = displayText
            print("PARTIAL:\(displayText)")
        }
    }
    if let error = error {
        // Task finished errors are normal on kill
        let nsError = error as NSError
        if nsError.code != 216 { // kAFAssistantErrorDomain code for cancelled
            print("ERROR:\(error.localizedDescription)")
        }
    }
}

// Handle SIGTERM/SIGINT gracefully
signal(SIGTERM) { _ in
    exit(0)
}
signal(SIGINT) { _ in
    exit(0)
}

RunLoop.current.run()
