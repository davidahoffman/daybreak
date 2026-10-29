// Central state + the Daybreak protocol client. The phone is deliberately
// dumb: every reply comes from the server; this file just moves audio and
// JSON across the LAN and tracks what screen to show.

import Foundation
import Observation

struct Bubble: Identifiable, Equatable {
    enum Role { case me, day, sys }
    let id = UUID()
    let role: Role
    var text: String
}

struct StatusResponse: Codable {
    struct DossierInfo: Codable {
        var exists: Bool
        var valid: Bool
        var problems: [String]
        var date: String?
        var headline: String?
    }
    struct RingInfo: Codable { var ringTime: String? }
    var dossier: DossierInfo
    var briefAudioReady: Bool
    var ring: RingInfo?
}

struct DossierResponse: Codable {
    var briefScript: String?
    var headline: String?
}

struct TurnResponse: Codable {
    var transcript: String?
    var replyText: String
    var replyAudioB64: String?
    var capturedActions: [String]?
}

@MainActor
@Observable
final class AppState {
    enum Phase: Equatable {
        case unpaired
        case connecting
        case waiting(String)   // server reachable, brief not ready
        case ready(String)     // headline
        case inCall
    }
    enum Talk: Equatable { case idle, recording, thinking, speaking }

    var phase: Phase = .connecting
    var talk: Talk = .idle
    var bubbles: [Bubble] = []
    var hint = ""

    // LAN-scoped secret; UserDefaults is fine at these stakes (Keychain: v1.1).
    var host: String {
        get { UserDefaults.standard.string(forKey: "daybreak.host") ?? "http://your-mac.local:7745" }
        set { UserDefaults.standard.set(newValue, forKey: "daybreak.host") }
    }
    var token: String {
        get { UserDefaults.standard.string(forKey: "daybreak.token") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "daybreak.token") }
    }

    let engine = CallEngine()

    // ---------- protocol plumbing ----------
    private func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, timeout: TimeInterval = 30) -> URLRequest {
        var req = URLRequest(url: URL(string: host + path)!, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        req.httpBody = body
        return req
    }

    private func getData(_ path: String, timeout: TimeInterval = 30) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(for: request(path, timeout: timeout))
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    private func get<T: Codable>(_ path: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await getData(path))
    }

    // ---------- lifecycle ----------
    func poll() async {
        guard !token.isEmpty else { phase = .unpaired; return }
        guard phase != .inCall else { return }
        do {
            let (data, resp) = try await URLSession.shared.data(for: request("/api/status", timeout: 6))
            if (resp as? HTTPURLResponse)?.statusCode == 401 { phase = .unpaired; return }
            let status = try JSONDecoder().decode(StatusResponse.self, from: data)
            if status.dossier.valid && status.briefAudioReady {
                phase = .ready(status.dossier.headline ?? "Your brief is ready")
            } else if status.dossier.exists {
                phase = .waiting(status.dossier.valid ? "Rendering your brief audio…" : "Dossier not ready yet")
            } else {
                phase = .waiting("No dossier yet — the prefetch writes it around 07:15.")
            }
        } catch {
            phase = .waiting("Can't reach the Daybreak server on \(host)")
        }
    }

    func pair(host newHost: String, token newToken: String) async {
        host = newHost.trimmingCharacters(in: .whitespacesAndNewlines)
        token = newToken.trimmingCharacters(in: .whitespacesAndNewlines)
        phase = .connecting
        await poll()
    }

    // ---------- the call ----------
    func answer() async {
        guard case .ready = phase else { return }
        engine.configureSession()
        phase = .inCall
        talk = .speaking
        hint = ""
        let dateLine = Date().formatted(.dateTime.weekday(.wide).month(.wide).day())
        bubbles = [Bubble(role: .sys, text: "Daybreak · \(dateLine)")]

        Task { _ = try? await URLSession.shared.data(for: request("/api/answered", method: "POST", body: Data("{}".utf8), contentType: "application/json")) }
        do {
            let dossier: DossierResponse = try await get("/api/dossier")
            if let script = dossier.briefScript, !script.isEmpty {
                bubbles.append(Bubble(role: .day, text: script))
            }
            let wav = try await getData("/api/brief.wav", timeout: 60)
            engine.play(data: wav) { [weak self] in
                self?.talk = .idle
                self?.hint = "your line — tap the mic"
            }
        } catch {
            bubbles.append(Bubble(role: .sys, text: "Couldn't fetch the brief: \(error.localizedDescription)"))
            talk = .idle
        }
    }

    func toggleMic() {
        if talk == .recording {
            engine.stopRecording()
            return
        }
        engine.stopPlayback() // barge-in: talking interrupts Daybreak
        talk = .recording
        hint = "listening — tap again or pause to send"
        engine.startRecording { [weak self] url in
            guard let self else { return }
            Task { await self.sendTurn(url) }
        }
    }

    private func sendTurn(_ url: URL?) async {
        guard let url else {
            talk = .idle
            hint = "didn't hear anything — tap the mic and speak"
            return
        }
        talk = .thinking
        hint = "thinking…"
        do {
            let audio = try Data(contentsOf: url)
            let req = request("/api/turn", method: "POST", body: audio, contentType: "audio/mp4", timeout: 90)
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let turn = try JSONDecoder().decode(TurnResponse.self, from: data)

            if let heard = turn.transcript, !heard.isEmpty {
                bubbles.append(Bubble(role: .me, text: heard))
            }
            bubbles.append(Bubble(role: .day, text: turn.replyText))
            for action in turn.capturedActions ?? [] {
                bubbles.append(Bubble(role: .sys, text: "✓ queued: \(action)"))
            }
            if let b64 = turn.replyAudioB64, let wav = Data(base64Encoded: b64) {
                talk = .speaking
                hint = ""
                engine.play(data: wav) { [weak self] in
                    self?.talk = .idle
                    self?.hint = "your line — tap the mic"
                }
            } else {
                talk = .idle
            }
        } catch {
            bubbles.append(Bubble(role: .sys, text: "Turn failed: \(error.localizedDescription)"))
            talk = .idle
            hint = "tap the mic to try again"
        }
    }

    func hangUp() async {
        engine.stopAll()
        _ = try? await URLSession.shared.data(for: request("/api/hangup", method: "POST", body: Data("{}".utf8), contentType: "application/json"))
        talk = .idle
        bubbles = []
        phase = .connecting
        await poll()
    }
}
