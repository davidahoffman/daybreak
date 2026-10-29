// mic-watch — prints "on" / "off" whenever any process starts or stops using the
// default input device, plus the current state at startup. Follows default-input
// changes (AirPods connecting). No permissions needed: it reads CoreAudio's
// IsRunningSomewhere flag and never opens the mic itself.
//
// Build: swiftc -O -o mic-watch main.swift   (server/lib/micwatch.mjs does this)

import CoreAudio
import Foundation

var system = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var running = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)

var device = AudioObjectID(0)
var last: String? = nil
let queue = DispatchQueue(label: "mic-watch")

func defaultInput() -> AudioObjectID {
    var id = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &system, 0, nil, &size, &id)
    return id
}

func emit() {
    var value = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    let ok = AudioObjectGetPropertyData(device, &running, 0, nil, &size, &value) == noErr
    let state = ok && value != 0 ? "on" : "off"
    if state != last {
        last = state
        print(state)
        fflush(stdout)
    }
}

let onRunningChange: AudioObjectPropertyListenerBlock = { _, _ in emit() }

func attach() {
    if device != 0 { AudioObjectRemovePropertyListenerBlock(device, &running, queue, onRunningChange) }
    device = defaultInput()
    AudioObjectAddPropertyListenerBlock(device, &running, queue, onRunningChange)
    emit()
}

AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &system, queue) { _, _ in attach() }
queue.sync { attach() }
dispatchMain()
