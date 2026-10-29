// All screens. Kept in one file on purpose — the app is a thin handset and
// the whole UI is four small views around one orb.

import SwiftUI

enum Dawn {
    static let bgTop = Color(red: 0.05, green: 0.06, blue: 0.13)
    static let bgBottom = Color(red: 0.10, green: 0.07, blue: 0.16)
    static let orange = Color(red: 1.00, green: 0.64, blue: 0.38)
    static let pink = Color(red: 1.00, green: 0.45, blue: 0.42)
    static let purple = Color(red: 0.55, green: 0.38, blue: 0.90)
    static let dim = Color.white.opacity(0.55)
}

struct ContentView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        ZStack {
            LinearGradient(colors: [Dawn.bgTop, Dawn.bgBottom], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            switch app.phase {
            case .unpaired:
                PairView()
            case .connecting:
                ProgressView().tint(.white)
            case .waiting(let message):
                WaitingView(message: message)
            case .ready(let headline):
                HomeView(headline: headline)
            case .inCall:
                CallView()
            }
        }
        .task {
            while !Task.isCancelled {
                await app.poll()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }
}

// MARK: - Pairing

struct PairView: View {
    @Environment(AppState.self) private var app
    @State private var host = ""
    @State private var token = ""

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            OrbView(size: 96, mode: .idle)
            Text("Daybreak")
                .font(.largeTitle.weight(.semibold))
                .foregroundStyle(.white)
            Text("Pair with the Daybreak server on your Mac.\nThe token is in daybreak/state/device-token.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Dawn.dim)
            VStack(spacing: 10) {
                TextField("http://your-mac.local:7745", text: $host)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                SecureField("Pairing token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .textFieldStyle(.plain)
            .padding(12)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
            .foregroundStyle(.white)

            Button {
                Task { await app.pair(host: host, token: token) }
            } label: {
                Text("Connect")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Dawn.orange, in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(.black)
            }
            .disabled(token.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(token.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 28)
        .onAppear { host = app.host }
    }
}

// MARK: - Waiting (server up, brief not ready)

struct WaitingView: View {
    @Environment(AppState.self) private var app
    let message: String

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            OrbView(size: 110, mode: .idle)
            Text("No call yet")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(Dawn.dim)
                .padding(.horizontal, 30)
            Button("Check again") { Task { await app.poll() } }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Dawn.orange)
            Spacer()
            Button("Re-pair") { app.token = ""; Task { await app.poll() } }
                .font(.caption)
                .foregroundStyle(Dawn.dim)
                .padding(.bottom, 24)
        }
    }
}

// MARK: - Home (brief ready — answer the call)

struct HomeView: View {
    @Environment(AppState.self) private var app
    let headline: String

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            OrbView(size: 150, mode: .ready)
            Text("Good morning")
                .font(.title.weight(.semibold))
                .foregroundStyle(.white)
            Text(headline)
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(Dawn.dim)
                .padding(.horizontal, 34)
            Spacer()
            Button {
                Task { await app.answer() }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "phone.fill")
                    Text("Answer your brief")
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Color.green.opacity(0.85), in: RoundedRectangle(cornerRadius: 18))
                .foregroundStyle(.white)
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 36)
        }
    }
}

// MARK: - The call

struct CallView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                OrbView(size: 40, mode: orbMode)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Daybreak").font(.headline).foregroundStyle(.white)
                    Text(statusLine).font(.caption).foregroundStyle(Dawn.dim)
                }
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(app.bubbles) { bubble in
                            BubbleView(bubble: bubble).id(bubble.id)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
                .onChange(of: app.bubbles.count) { _, _ in
                    if let last = app.bubbles.last {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            VStack(spacing: 10) {
                if !app.hint.isEmpty {
                    Text(app.hint).font(.caption).foregroundStyle(Dawn.dim)
                }
                HStack(spacing: 44) {
                    Button {
                        Task { await app.hangUp() }
                    } label: {
                        Image(systemName: "phone.down.fill")
                            .font(.title2)
                            .frame(width: 62, height: 62)
                            .background(Color.red.opacity(0.85), in: Circle())
                            .foregroundStyle(.white)
                    }
                    Button {
                        app.toggleMic()
                    } label: {
                        Image(systemName: micIcon)
                            .font(.title2)
                            .frame(width: 62, height: 62)
                            .background(micBackground, in: Circle())
                            .foregroundStyle(.white)
                    }
                    .disabled(app.talk == .thinking)
                }
            }
            .padding(.bottom, 30)
            .padding(.top, 6)
        }
    }

    private var orbMode: OrbMode {
        switch app.talk {
        case .idle: return .line
        case .recording: return .listening(level: 0)
        case .thinking: return .thinking
        case .speaking: return .speaking
        }
    }

    private var statusLine: String {
        switch app.talk {
        case .idle: return "on the line"
        case .recording: return "listening…"
        case .thinking: return "thinking…"
        case .speaking: return "speaking"
        }
    }

    private var micIcon: String {
        switch app.talk {
        case .recording: return "stop.fill"
        case .thinking: return "ellipsis"
        default: return "mic.fill"
        }
    }

    private var micBackground: Color {
        app.talk == .recording ? Dawn.pink : Color.white.opacity(0.14)
    }
}

struct BubbleView: View {
    let bubble: Bubble

    var body: some View {
        switch bubble.role {
        case .sys:
            Text(bubble.text)
                .font(.caption)
                .foregroundStyle(Dawn.dim)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 2)
        case .me:
            HStack {
                Spacer(minLength: 48)
                Text(bubble.text)
                    .font(.callout)
                    .foregroundStyle(.black)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Dawn.orange.opacity(0.92), in: RoundedRectangle(cornerRadius: 16))
            }
        case .day:
            HStack {
                Text(bubble.text)
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.92))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                Spacer(minLength: 48)
            }
        }
    }
}

// The orb lives in OrbView.swift — Shelly's blob orb, re-paletted for dawn.
