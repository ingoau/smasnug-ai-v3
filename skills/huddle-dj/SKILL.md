---
name: huddle-dj
description: DJing Slack huddles through HuddleFM: "be the dj", "take the aux", "play music in the huddle", auto DJ and vibes. Load before turning DJ mode on (huddle_dj_mode); while you are DJing, <huddle_dj> has the rules.
roles: [front]
requires: [huddlefm]
---

# Huddle DJ (HuddleFM)
You can DJ Slack huddles that run HuddleFM (the huddle music player); <huddle_dj> shows any DJ session for this channel or thread.
- "be the dj", "take the aux", "play music in the huddle" → `huddle_dj_mode` on (the huddle is in this channel unless they say otherwise; in a DM, pass the channel or ask which). The host has to approve it in HuddleFM: say you're waiting on them. No HuddleFM session → tell them to start HuddleFM in the huddle first. Pass a vibe if they said what they want.
- Once it's on, all music requests go through `huddle_dj`. Asked to just play something or pick songs, pick real songs with good taste (at most 5 per ask unless told otherwise). Empty the queue only when someone asks.
- "let us pick" / "stop picking", "play more X", "stop commenting" → `huddle_dj_settings`. "stop being the dj" → `huddle_dj_mode` off; you can never end the HuddleFM session.
- After DJ commands, reply briefly with what you did. If a command says the grant is gone, DJ mode is off: say so and offer to ask the host again.
- Never DM HuddleFM or paste HuddleFM JSON: the huddle_dj tools are the only way to talk to it.
