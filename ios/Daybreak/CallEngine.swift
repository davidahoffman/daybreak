// Audio in/out. Mirrors the web handset's behavior exactly:
//   - play WAV data (brief + replies), report when playback ends
//   - record AAC/m4a with live metering; auto-stop after ~1.6s of quiet
//     once the user has spoken; discard no-speech or <0.4s recordings so
//     silence never reaches whisper (it hallucinates on silence)

import AVFoundation

@MainActor
final class CallEngine: NSObject {
    private var player: AVAudioPlayer?
    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var heardSpeech = false
    private var quietMs = 0.0
    private var recStart = Date()
    private var onPlayEnd: (() -> Void)?
    private var onRecFinish: ((URL?) -> Void)?

    private let speechThresholdDB: Float = -37
    private let quietStopMs = 1600.0
    private let minTakeSeconds = 0.4

    func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetooth])
        try? session.setActive(true)
    }

    // ---------- playback ----------
    func play(data: Data, onEnd: @escaping () -> Void) {
        stopPlayback()
        onPlayEnd = onEnd
        do {
            let p = try AVAudioPlayer(data: data)
            p.delegate = self
            player = p
            if !p.play() { finishPlayback() }
        } catch {
            finishPlayback()
        }
    }

    func stopPlayback() {
        player?.stop()
        player = nil
        onPlayEnd = nil
    }

    private func finishPlayback() {
        let cb = onPlayEnd
        player = nil
        onPlayEnd = nil
        cb?()
    }

    // ---------- recording ----------
    func startRecording(onFinish: @escaping (URL?) -> Void) {
        stopRecordingInternals()
        onRecFinish = onFinish
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                guard granted else { self.deliver(nil); return }
                self.beginTake()
            }
        }
    }

    private func beginTake() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("daybreak-turn.m4a")
        try? FileManager.default.removeItem(at: url)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 24_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 48_000,
        ]
        do {
            let r = try AVAudioRecorder(url: url, settings: settings)
            r.delegate = self
            r.isMeteringEnabled = true
            guard r.record() else { deliver(nil); return }
            recorder = r
            heardSpeech = false
            quietMs = 0
            recStart = Date()
            meterTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tickMeter() }
            }
        } catch {
            deliver(nil)
        }
    }

    private func tickMeter() {
        guard let r = recorder else { return }
        r.updateMeters()
        let power = r.averagePower(forChannel: 0)
        if power > speechThresholdDB {
            heardSpeech = true
            quietMs = 0
        } else if heardSpeech {
            quietMs += 120
            if quietMs > quietStopMs { stopRecording() }
        }
    }

    func stopRecording() {
        guard let r = recorder else { return }
        meterTimer?.invalidate()
        meterTimer = nil
        r.stop() // finalizes the file, then the delegate fires
    }

    private func stopRecordingInternals() {
        meterTimer?.invalidate()
        meterTimer = nil
        recorder?.delegate = nil
        recorder?.stop()
        recorder = nil
        onRecFinish = nil
    }

    private func deliver(_ url: URL?) {
        let cb = onRecFinish
        onRecFinish = nil
        recorder = nil
        cb?(url)
    }

    func stopAll() {
        stopPlayback()
        stopRecordingInternals()
    }
}

extension CallEngine: AVAudioPlayerDelegate, AVAudioRecorderDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finishPlayback() }
    }

    nonisolated func audioRecorderDidFinishRecording(_ rec: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            let duration = Date().timeIntervalSince(self.recStart)
            let keep = flag && self.heardSpeech && duration >= self.minTakeSeconds
            self.deliver(keep ? rec.url : nil)
        }
    }
}
