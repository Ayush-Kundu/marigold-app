// eventkit — Calendar + Reminders for Marigold's watcher, as JSON.
//   eventkit events <fromMin> <toMin>   → events starting between now+fromMin and now+toMin
//   eventkit reminders <aheadMin>       → open reminders due before now+aheadMin (incl. overdue today)
//   eventkit status                     → access status for events/reminders
import EventKit
import Foundation

let store = EKEventStore()
let args = CommandLine.arguments
let iso = ISO8601DateFormatter()

func access(_ type: EKEntityType) -> Bool {
  let s = EKEventStore.authorizationStatus(for: type)
  if s == .fullAccess || s == .authorized { return true }
  if s != .notDetermined { return false }
  let sem = DispatchSemaphore(value: 0)
  var ok = false
  if type == .event { store.requestFullAccessToEvents { g, _ in ok = g; sem.signal() } }
  else { store.requestFullAccessToReminders { g, _ in ok = g; sem.signal() } }
  _ = sem.wait(timeout: .now() + 120)
  return ok
}
func out(_ v: Any) {
  let d = try! JSONSerialization.data(withJSONObject: v, options: [])
  print(String(data: d, encoding: .utf8)!)
}

guard args.count >= 2 else { print("usage"); exit(1) }
switch args[1] {
case "status":
  out(["events": EKEventStore.authorizationStatus(for: .event).rawValue, "reminders": EKEventStore.authorizationStatus(for: .reminder).rawValue])
case "events":
  guard access(.event) else { out(["error": "no calendar access"]); exit(0) }
  let from = Double(args.count > 2 ? args[2] : "0") ?? 0, to = Double(args.count > 3 ? args[3] : "60") ?? 60
  let start = Date().addingTimeInterval(from * 60), end = Date().addingTimeInterval(to * 60)
  let pred = store.predicateForEvents(withStart: start.addingTimeInterval(-60), end: end, calendars: nil)
  let evs = store.events(matching: pred).filter { $0.startDate >= start.addingTimeInterval(-60) && $0.startDate <= end }
  out(evs.map { e -> [String: Any] in
    ["id": e.eventIdentifier ?? "", "title": e.title ?? "", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate),
     "allDay": e.isAllDay, "location": e.location ?? "", "notes": String((e.notes ?? "").prefix(300)), "calendar": e.calendar?.title ?? "",
     "url": e.url?.absoluteString ?? ""]
  })
case "reminders":
  guard access(.reminder) else { out(["error": "no reminders access"]); exit(0) }
  let ahead = Double(args.count > 2 ? args[2] : "15") ?? 15
  let pred = store.predicateForIncompleteReminders(withDueDateStarting: Date().addingTimeInterval(-86400), ending: Date().addingTimeInterval(ahead * 60), calendars: nil)
  let sem = DispatchSemaphore(value: 0)
  var rows: [[String: Any]] = []
  store.fetchReminders(matching: pred) { rs in
    for r in rs ?? [] {
      let due = r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
      rows.append(["id": r.calendarItemIdentifier, "title": r.title ?? "", "due": due.map { iso.string(from: $0) } ?? "", "list": r.calendar?.title ?? "", "notes": String((r.notes ?? "").prefix(200))])
    }
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + 30)
  out(rows)
default:
  print("unknown"); exit(1)
}
