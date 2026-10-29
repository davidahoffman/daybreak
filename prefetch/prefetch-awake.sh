#!/bin/zsh
# Closed-lid mornings: `pmset repeat wakeorpoweron` wakes the Mac at 06:50, but
# a dark wake drops back to sleep within minutes unless something holds a power
# assertion. 2026-09-14: the 06:55 gather started on schedule, the Mac re-slept
# mid-run, and the 25-minute-timeout claude step took 178 wall-clock minutes,
# resuming only at lid-open (10:04). This wrapper is that assertion.
#
# caffeinate -s (prevent system sleep) only holds on AC power; -i covers idle
# sleep with the lid open. On battery with the lid closed macOS forces sleep
# regardless — no userland assertion can stop that.

/usr/bin/caffeinate -i -s node "${0:A:h}/prefetch.mjs"
rc=$?

# Exit 3 = gather deferred (battery + closed lid): the machine is about to
# force-sleep anyway, so holding an assertion until 08:10 is pointless — and on
# battery it would just burn charge across every dark wake. Get out of the way.
if [ "$rc" -eq 3 ]; then
  exit $rc
fi

# The dossier landing isn't the finish line: the server still has to render the
# TTS brief and post the 07:40 Slack leg + workflow notify, and on a failed
# gather the server watchdog (07:35+) needs an awake Mac for its retry. Hold
# until 08:10 local; a run already past that (07:25 retry overruns, manual run)
# holds nothing.
end_epoch=$(date -j -f "%H:%M:%S" "08:10:00" "+%s" 2>/dev/null)
now_epoch=$(date +%s)
if [ -n "$end_epoch" ] && [ "$end_epoch" -gt "$now_epoch" ]; then
  /usr/bin/caffeinate -i -s -t $(( end_epoch - now_epoch ))
fi

exit $rc
