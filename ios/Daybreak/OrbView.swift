// The orb — ported from Shelly's ShellyOrbView (apps/pm-os-menubar), re-paletted
// for Daybreak's dawn identity. Pure SwiftUI: a sine-deformed blob, orbiting
// blurred plasma, occasional shooting stars, pulse rings when a brief is waiting.
// .drawingGroup() flattens each frame to one Metal texture, so the layered blurs
// stay cheap. Animation is TimelineView-driven, never repeatForever (see memory:
// feedback_swiftui_repeatforever_scroll — CallView puts this inside a ScrollView).

import SwiftUI

enum OrbMode: Equatable {
    /// Pre-dawn: pairing / no brief yet.
    case idle
    /// Sunrise: the brief is ready — the "answer your call" invitation.
    case ready
    /// In-call, nobody talking.
    case line
    /// Mic is hot. `level` (0-1) adds breath, when the caller wires it.
    case listening(level: CGFloat)
    case thinking
    case speaking
}

// A circle whose radius is modulated by four sine harmonics, so the edge
// slowly boils instead of sitting still.
struct BlobShape: Shape {
    var time: Double
    var complexity: Double

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(time, complexity) }
        set { time = newValue.first; complexity = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        let cx = rect.midX
        let cy = rect.midY
        let base = min(rect.width, rect.height) / 2
        let n = 120

        var path = Path()
        for i in 0...n {
            let θ = Double(i) / Double(n) * 2 * .pi
            var r = base
            r += base * complexity * sin(2 * θ + time * 0.55)
            r += base * complexity * 0.55 * sin(3 * θ - time * 0.42)
            r += base * complexity * 0.35 * cos(4 * θ + time * 0.65)
            r += base * complexity * 0.15 * sin(5 * θ - time * 0.30)

            let x = cx + cos(θ) * r
            let y = cy + sin(θ) * r
            if i == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        path.closeSubpath()
        return path
    }
}

// Accumulates phase across mode changes so a speed shift bends the motion
// instead of jumping it.
private final class PhaseAccumulator {
    var phase: Double = 0
    var lastTime: Double = 0

    func tick(time: Double, speed: Double) -> Double {
        if lastTime > 0 {
            phase += (time - lastTime) * speed
        }
        lastTime = time
        return phase
    }
}

// One dawn, six moments. idle = night's end, ready = sunrise, speaking = daylight gold.
private struct OrbPalette {
    let core, mid, deep, bright, soft, warm, glow: Color

    static let idle = OrbPalette(
        core: Color(red: 0.48, green: 0.42, blue: 0.78),
        mid: Color(red: 0.30, green: 0.21, blue: 0.58),
        deep: Color(red: 0.10, green: 0.08, blue: 0.28),
        bright: Color(red: 0.58, green: 0.48, blue: 0.96),
        soft: Color(red: 0.62, green: 0.34, blue: 0.58),
        warm: Color(red: 0.78, green: 0.46, blue: 0.36),
        glow: Color(red: 0.46, green: 0.36, blue: 0.86)
    )
    static let ready = OrbPalette(
        core: Color(red: 1.00, green: 0.66, blue: 0.40),
        mid: Color(red: 0.98, green: 0.45, blue: 0.42),
        deep: Color(red: 0.34, green: 0.16, blue: 0.52),
        bright: Color(red: 1.00, green: 0.82, blue: 0.48),
        soft: Color(red: 1.00, green: 0.52, blue: 0.55),
        warm: Color(red: 1.00, green: 0.58, blue: 0.34),
        glow: Color(red: 1.00, green: 0.60, blue: 0.38)
    )
    static let line = OrbPalette(
        core: Color(red: 0.94, green: 0.60, blue: 0.42),
        mid: Color(red: 0.80, green: 0.40, blue: 0.44),
        deep: Color(red: 0.26, green: 0.14, blue: 0.42),
        bright: Color(red: 0.98, green: 0.74, blue: 0.48),
        soft: Color(red: 0.88, green: 0.48, blue: 0.56),
        warm: Color(red: 0.92, green: 0.54, blue: 0.38),
        glow: Color(red: 0.90, green: 0.55, blue: 0.40)
    )
    static let listening = OrbPalette(
        core: Color(red: 1.00, green: 0.56, blue: 0.60),
        mid: Color(red: 0.85, green: 0.36, blue: 0.50),
        deep: Color(red: 0.32, green: 0.12, blue: 0.38),
        bright: Color(red: 1.00, green: 0.70, blue: 0.74),
        soft: Color(red: 0.95, green: 0.48, blue: 0.62),
        warm: Color(red: 1.00, green: 0.60, blue: 0.52),
        glow: Color(red: 0.98, green: 0.50, blue: 0.58)
    )
    static let thinking = OrbPalette(
        core: Color(red: 0.64, green: 0.62, blue: 0.98),
        mid: Color(red: 0.42, green: 0.36, blue: 0.86),
        deep: Color(red: 0.14, green: 0.12, blue: 0.40),
        bright: Color(red: 0.72, green: 0.74, blue: 1.00),
        soft: Color(red: 0.55, green: 0.48, blue: 0.92),
        warm: Color(red: 0.68, green: 0.52, blue: 0.90),
        glow: Color(red: 0.54, green: 0.52, blue: 0.96)
    )
    static let speaking = OrbPalette(
        core: Color(red: 1.00, green: 0.80, blue: 0.48),
        mid: Color(red: 1.00, green: 0.56, blue: 0.36),
        deep: Color(red: 0.44, green: 0.20, blue: 0.40),
        bright: Color(red: 1.00, green: 0.90, blue: 0.62),
        soft: Color(red: 1.00, green: 0.64, blue: 0.45),
        warm: Color(red: 1.00, green: 0.70, blue: 0.40),
        glow: Color(red: 1.00, green: 0.68, blue: 0.42)
    )
}

struct OrbView: View {
    let size: CGFloat
    var mode: OrbMode = .idle
    var organic: CGFloat = 0.07

    @State private var phaseAcc = PhaseAccumulator()

    private var palette: OrbPalette {
        switch mode {
        case .idle: return .idle
        case .ready: return .ready
        case .line: return .line
        case .listening: return .listening
        case .thinking: return .thinking
        case .speaking: return .speaking
        }
    }

    private var speed: Double {
        switch mode {
        case .idle: return 0.5
        case .ready: return 1.6
        case .line: return 0.65
        case .listening: return 0.8
        case .thinking: return 1.1
        case .speaking: return 0.7
        }
    }

    private var breatheScale: Double {
        switch mode {
        case .idle: return 0.018
        case .ready: return 0.045
        case .line: return 0.024
        case .listening(let level): return 0.028 + Double(level) * 0.045
        case .thinking: return 0.036
        case .speaking: return 0.028
        }
    }

    private var glowOpacity: Double {
        switch mode {
        case .idle: return 0.30
        case .ready: return 0.58
        case .line: return 0.40
        case .listening: return 0.46
        case .thinking: return 0.50
        case .speaking: return 0.46
        }
    }

    private var animationInterval: TimeInterval {
        switch mode {
        case .idle: return 1.0 / 24.0
        default: return 1.0 / 30.0
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: animationInterval)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let bt = phaseAcc.tick(time: t, speed: speed)
            orbCanvas(time: t, bt: bt)
        }
        .frame(width: size * 1.15, height: size * 1.15)
    }

    @ViewBuilder
    private func orbCanvas(time: Double, bt: Double) -> some View {
        let d = size * 0.82
        let breathe = 1.0 + sin(time * 2.5) * breatheScale
        let blob = BlobShape(time: bt, complexity: Double(organic))
        let p = palette

        ZStack {
            softGlow(time: bt, palette: p, opacity: glowOpacity)

            if case .ready = mode {
                pulseRing(time: time, delay: 0.0, d: d, bt: bt)
                pulseRing(time: time, delay: 1.0, d: d, bt: bt)
            }

            ZStack {
                blob.fill(
                    RadialGradient(
                        colors: [p.core, p.mid, p.deep],
                        center: .init(x: 0.42, y: 0.38),
                        startRadius: 0,
                        endRadius: d * 0.58
                    )
                )
                .frame(width: d, height: d)

                ZStack {
                    plasma(i: 0, bt: bt, color: p.bright.opacity(0.55),
                           w: 0.55, h: 0.42, sm: 1.0, orbit: 0.18)
                    plasma(i: 1, bt: bt, color: p.soft.opacity(0.50),
                           w: 0.48, h: 0.38, sm: 0.7, orbit: 0.16)
                    plasma(i: 2, bt: bt, color: p.warm.opacity(0.35),
                           w: 0.42, h: 0.34, sm: 1.4, orbit: 0.13)
                    plasma(i: 3, bt: bt, color: p.core.opacity(0.40),
                           w: 0.46, h: 0.36, sm: 0.9, orbit: 0.15)
                    plasma(i: 4, bt: bt, color: Color.white.opacity(0.18),
                           w: 0.32, h: 0.26, sm: 0.5, orbit: 0.09)
                }
                .blur(radius: d * 0.07)
                .frame(width: d, height: d)
                .clipShape(blob)

                shootingStars(time: time, d: d)
                    .frame(width: d, height: d)
                    .clipShape(blob)

                blob.fill(
                    RadialGradient(
                        colors: [.clear, .clear, .black.opacity(0.15)],
                        center: .init(x: 0.42, y: 0.38),
                        startRadius: d * 0.28,
                        endRadius: d * 0.54
                    )
                )
                .frame(width: d, height: d)
            }
            .scaleEffect(breathe)
        }
        .drawingGroup(opaque: false, colorMode: .linear)
    }

    @ViewBuilder
    private func softGlow(time: Double, palette: OrbPalette, opacity: Double) -> some View {
        BlobShape(time: time * 0.6, complexity: Double(organic) * 0.45)
            .fill(
                RadialGradient(
                    colors: [
                        palette.glow.opacity(opacity * 0.34),
                        palette.bright.opacity(opacity * 0.16),
                        palette.soft.opacity(opacity * 0.08),
                        .clear
                    ],
                    center: .init(x: 0.48, y: 0.46),
                    startRadius: 0,
                    endRadius: size * 0.49
                )
            )
            .frame(width: size * 0.98, height: size * 0.98)
            .blur(radius: size * 0.015)
    }

    @ViewBuilder
    private func plasma(i: Int, bt: Double, color: Color,
                        w: CGFloat, h: CGFloat, sm: Double, orbit: CGFloat) -> some View {
        let d = size * 0.82
        let angle = bt * sm + Double(i) * .pi * 0.618
        let wobble = sin(bt * 0.35 + Double(i) * 2.7)
        let r = d * orbit * (1.0 + wobble * 0.4)

        Ellipse()
            .fill(color)
            .frame(width: d * w, height: d * h)
            .rotationEffect(.degrees(bt * 14 * sm + Double(i) * 72))
            .offset(x: cos(angle) * r, y: sin(angle) * r)
    }

    @ViewBuilder
    private func shootingStars(time: Double, d: CGFloat) -> some View {
        Canvas { context, _ in
            context.addFilter(.blur(radius: 0.65))
            for index in 0..<2 {
                let star = starState(index: index, time: time, d: d)
                guard star.opacity > 0.01 else { continue }

                var path = Path()
                path.move(to: CGPoint(x: star.x - star.dx, y: star.y - star.dy))
                path.addLine(to: CGPoint(x: star.x + star.dx, y: star.y + star.dy))
                context.stroke(
                    path,
                    with: .color(.white.opacity(star.opacity)),
                    style: StrokeStyle(lineWidth: 2, lineCap: .round)
                )
            }
        }
    }

    private func starState(index: Int, time: Double, d: CGFloat) -> (x: CGFloat, y: CGFloat, dx: CGFloat, dy: CGFloat, opacity: Double) {
        let period = 8.0 + Double(index) * 3.0
        let phase = Double(index) * 2.9
        let rawCycle = (time + phase).truncatingRemainder(dividingBy: period)
        let cycle = rawCycle / period

        let activeWindow = 0.10
        let progress = cycle / activeWindow
        let isActive = cycle < activeWindow

        let cycleNum = floor((time + phase) / period)
        let pathAngle = Double(index) * 1.1 + cycleNum * 0.8
        let perpAngle = pathAngle + .pi / 2

        let halfTravel = Double(d) * 0.40
        let pos = -halfTravel + progress * halfTravel * 2

        let perpDist = Double(d) * sin(Double(index) * 2.7 + cycleNum * 1.3) * 0.12
        let arcBow = sin(progress * .pi) * Double(d) * 0.08

        let x = cos(pathAngle) * pos + cos(perpAngle) * (perpDist + arcBow)
        let y = sin(pathAngle) * pos + sin(perpAngle) * (perpDist + arcBow)

        let fadeIn = min(progress * 4, 1.0)
        let fadeOut = min((1.0 - progress) * 3, 1.0)
        let opacity = isActive ? fadeIn * fadeOut * 0.5 : 0.0

        let halfLength: Double = 8
        return (
            x: CGFloat(x),
            y: CGFloat(y),
            dx: CGFloat(cos(pathAngle) * halfLength),
            dy: CGFloat(sin(pathAngle) * halfLength),
            opacity: opacity
        )
    }

    @ViewBuilder
    private func pulseRing(time: Double, delay: Double, d: CGFloat, bt: Double) -> some View {
        let cycle = (time * 0.5 + delay).truncatingRemainder(dividingBy: 2.0) / 2.0
        let scale = 1.0 + cycle * 0.35
        let ringOpacity = (1.0 - cycle) * 0.30

        BlobShape(time: bt, complexity: Double(organic) * 0.5)
            .stroke(palette.glow.opacity(ringOpacity), lineWidth: 1.5)
            .frame(width: d, height: d)
            .scaleEffect(scale)
    }
}

#Preview("Ready") {
    OrbView(size: 220, mode: .ready)
        .padding(60)
        .background(Color(white: 0.05))
}
