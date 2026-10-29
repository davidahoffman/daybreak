// Weekday 07:45 local notifications — the v0.1 "ring". Static schedule: the
// notification is generic ("your call is ready"), and the app checks the
// server for a real dossier on open. A server-initiated push that can honor
// the no-dossier-no-ring gate at fire time is the v1.1 upgrade (VoIP/CallKit).

import UserNotifications

enum NotificationScheduler {
    static let ringHour = 7
    static let ringMinute = 45

    static func ensureScheduled() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            center.getPendingNotificationRequests { pending in
                let have = Set(pending.map(\.identifier))
                for weekday in 2...6 { // Calendar: 1 = Sunday
                    let id = "daybreak-ring-wd\(weekday)"
                    guard !have.contains(id) else { continue }
                    let content = UNMutableNotificationContent()
                    content.title = "Daybreak"
                    content.body = "Your morning call is ready — tap to answer."
                    content.sound = .default
                    content.interruptionLevel = .timeSensitive
                    var match = DateComponents()
                    match.hour = ringHour
                    match.minute = ringMinute
                    match.weekday = weekday
                    let trigger = UNCalendarNotificationTrigger(dateMatching: match, repeats: true)
                    center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
                }
            }
        }
    }
}
