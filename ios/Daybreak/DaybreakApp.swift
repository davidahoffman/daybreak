// Daybreak — the phone that receives your morning call.
//
// Thin handset: all intelligence lives on the Daybreak server (the Mac).
// This app pairs, rings via scheduled local notifications at 07:45 on
// weekdays, plays the pre-rendered brief, and streams voice turns.
// v1.1 direction: server-initiated VoIP push for a true lock-screen ring.

import SwiftUI

@main
struct DaybreakApp: App {
    @State private var app = AppState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(app)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await app.poll() }
                NotificationScheduler.ensureScheduled()
            }
        }
    }
}
