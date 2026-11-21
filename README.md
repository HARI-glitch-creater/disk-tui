# disk-tui

A zero-dependency, 60 FPS touch-and-keyboard Terminal User Interface (TUI) for visualizing and managing installed Linux packages. Built in plain Node.js using raw ANSI escape codes and a diff-buffer renderer.

## Features

- **Squarified Treemap Layout:** Proportional heatmap tiles sized by disk usage, auto-adapting from mobile Termux screens (`30x15`) to ultrawide desktop monitors (`240x70`).
- **60 FPS Diff-Buffer Renderer:** Synchronized frame updates (`\x1b[?2026h`) that flush only changed cells for zero flicker.
- **Translucent Glass Aesthetic:** 360-degree pastel color-wheel borders with dark translucent tints over your terminal background, ratio-scaled block typography, and zero emojis.
- **Live Search & Detail View:** Instant autocomplete search bar (`/`) and full-screen package detail page with storage share, install command, and reverse-dependency inspection.
- **Cross-Distro Backend:** Auto-detects and manages packages across:
  - **Debian / Ubuntu / Termux PRoot** (`dpkg-query`, `apt-cache`, `apt-get`)
  - **Arch Linux** (`pacman`)
  - **Fedora / RHEL / CentOS** (`rpm`, `dnf`, `yum`)
  - **Alpine Linux** (`apk`)
  - **Global NPM** (`npm`, `du`)

## Installation

### From GitHub
```bash
git clone https://github.com/<your-username>/disk-tui.git
cd disk-tui
npm link
disk-tui
```

### Direct Global Wrapper (PRoot / Termux / No-Symlink Filesystems)
```bash
chmod 755 bin/disk-tui.js
printf '#!/bin/sh\nexec node "%s/bin/disk-tui.js" "$@"\n' "$(pwd)" > /usr/local/bin/disk-tui
chmod 755 /usr/local/bin/disk-tui
disk-tui
```

## Controls

| Action | Touch / Mouse | Keyboard |
| :--- | :--- | :--- |
| **Zoom In / Out** | Swipe Down / Up, or Scroll Wheel | `↓` / `→` / `+` and `↑` / `←` / `-` |
| **Inspect Package** | Tap any tile | `Enter` |
| **Search Packages** | Tap top search bar | `/` |
| **Close Modal / Back** | Tap outside card or `‹ BACK` | `Esc` |
| **Exit** | Swipe Left or double-tap top-right | `q` or `Ctrl+C` |

## Requirements

- Node.js `>= 18.0.0`
- TrueColor (24-bit) terminal (Termux, Kitty, Alacritty, WezTerm, GNOME Terminal, Windows Terminal, iTerm2)

## License

MIT
