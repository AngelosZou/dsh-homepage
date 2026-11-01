/**
 * The shipped default card-wall scheme.
 *
 * Recorded from a hand-tuned wall: `layout` is the per-card span and
 * `appearance` is the artwork override (icon or image, opacity, size, offset,
 * fade and blend). The host seeds it only when no home-state.json exists, so a
 * fresh profile starts from this wall and an existing profile keeps its own
 * settings.
 *
 * GENERATED DATA - regenerate from a live home-state.json; do not hand-edit.
 */
export const DEFAULT_SCHEME = {
  "layout": {
    "device": {
      "w": 2,
      "h": 1
    },
    "plugin-audit": {
      "w": 2,
      "h": 1
    },
    "sessions": {
      "w": 2,
      "h": 1
    },
    "projects": {
      "w": 1,
      "h": 1
    },
    "skill": {
      "w": 1,
      "h": 1
    },
    "hygiene": {
      "w": 1,
      "h": 1
    },
    "network": {
      "w": 1,
      "h": 1
    },
    "token": {
      "w": 1,
      "h": 1
    }
  },
  "appearance": {
    "tool-usage": {
      "icon": "grid",
      "opacity": 5,
      "size": 196,
      "bleed": "-16%",
      "offset": [
        -62,
        0
      ]
    },
    "sessions": {
      "icon": "sessions",
      "opacity": 0.08,
      "size": 233,
      "bleed": "-16%",
      "offset": [
        -11,
        0
      ]
    },
    "projects": {
      "icon": "projects",
      "opacity": 0.04,
      "size": 181,
      "bleed": "-16%",
      "offset": [
        36,
        0
      ]
    },
    "device": {
      "opacity": 0.06,
      "offset": [
        27,
        0
      ]
    },
    "skill": {
      "icon": "skill",
      "opacity": 0.06,
      "size": 193,
      "bleed": "-16%",
      "offset": [
        14,
        0
      ]
    }
  }
}
