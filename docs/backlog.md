# Backlog

Ideas parked until the work in flight is finished. One entry per idea, newest first.

## IP and RTSP network cameras (from the floor canvas, 2026-10-23)

Security and IP cameras stream RTSP, which no browser can play. Each one would need a converter on the laptop (for
example MediaMTX or go2rtc turning RTSP into WebRTC or HLS) that `/line` then opens like a phone. Out of scope for the
canvas: a station's camera today is a USB camera (anything Chrome lists), a phone or tablet, or a recorded clip.

## Floor shapes: tables, walls and walkways on the floor (from the floor canvas, 2026-10-23)

The floor shows only the station cards and the flow arrows. Drawing the tables (like the two in Michael's photo),
walls, walkways or the material path would make a layout read like the real room. Also a candidate: WIP counts on the
flow arrows instead of only in the summary's flow row.

## Role-based views: operator, manager, plant manager (from the floor canvas, 2026-10-23)

One canvas for all three, each seeing what it needs. Comes with the dashboard (`docs/dashboard-plan.md`, Phase 1):
an operator signs in on the station's Op chip and sees their own detail; a manager sees patterns, never a ranking; a
plant manager could see several layouts. Where it plugs in on `/line`: the operator chip, the cards (a tint for drift
or a slow step) and a view switch that does not exist yet.

## Done: floor canvas (Michael, 2026-10-23)

Built on branch `canvas` ([canvas-plan.md](canvas-plan.md)): `/line` is a floor you pan and zoom, with each station's
card where it stands and flow arrows; a built-in Class test layout (the L from the photo, four stations) and saved
layouts; Add station (phone or tablet, USB camera, or a clip); any number of stations; and an operator code with a
training level on every station, logged as the dashboard plan's `operator` event. The photo shows three stations and
the line has four trained roles: Class test has four, and removing one takes two clicks.
