#!/usr/bin/env node

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const args = process.argv.slice(2);
if (args.includes('-v') || args.includes('--version')) {
  console.log(`disk-tui v${VERSION}`);
  process.exit(0);
}
if (args.includes('-h') || args.includes('--help')) {
  console.log(`disk-tui v${VERSION} — 60 FPS Touch & Keyboard Linux Package Storage Visualizer

Usage:
  disk-tui              Launch interactive treemap TUI
  disk-tui --version    Print version
  disk-tui --help       Show this help

Controls:
  Touch / Mouse:  Tap tile for details | Swipe Down/Up or Scroll to zoom | Tap search bar | Swipe Left to exit
  Keyboard:       Arrows or +/- to zoom | / to search | Enter to open | Esc to go back | q to quit`);
  process.exit(0);
}

const execFileAsync = promisify(execFile);

// ============================================================================
// 1. CROSS-DISTRO LINUX BACKEND (APT, PACMAN, RPM/DNF, APK, GLOBAL NPM)
// ============================================================================
function formatSize(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(b >= 102400 ? 0 : 1) + ' KB';
  return b + ' B';
}

async function cmdExists(cmd) {
  try {
    await execFileAsync('which', [cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function isRootUser() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function parseHumanSizeToBytes(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^([\d.]+)\s*([KMGTP]?i?B?)?$/i);
  if (!m) return 0;
  const val = parseFloat(m[1]) || 0;
  const unit = (m[2] || '').toUpperCase();
  if (unit.startsWith('T')) return Math.round(val * 1099511627776);
  if (unit.startsWith('G')) return Math.round(val * 1073741824);
  if (unit.startsWith('M')) return Math.round(val * 1048576);
  if (unit.startsWith('K')) return Math.round(val * 1024);
  return Math.round(val);
}

const powersCache = new Map();

const backend = {
  async getPrograms() {
    const programs = [];
    const seen = new Set();

    const [hasDpkg, hasPacman, hasRpm, hasApk, hasNpm] = await Promise.all([
      cmdExists('dpkg-query'),
      cmdExists('pacman'),
      cmdExists('rpm'),
      cmdExists('apk'),
      cmdExists('npm'),
    ]);

    const scanners = [];

    // --- 1. Debian / Ubuntu / PRoot / Termux (dpkg-query) ---
    if (hasDpkg) {
      scanners.push(
        (async () => {
          try {
            const { stdout } = await execFileAsync(
              'dpkg-query',
              ['-W', '-f=${Status}\t${Installed-Size}\t${Package}\t${binary:Summary}\n'],
              { maxBuffer: 32 * 1024 * 1024, timeout: 15000 }
            );
            for (const line of stdout.split('\n')) {
              if (!line) continue;
              const parts = line.split('\t');
              if (parts.length < 3) continue;
              const status = parts[0] || '';
              if (!status.includes('install ok installed')) continue;
              const kb = parseInt(parts[1], 10) || 0;
              const name = (parts[2] || '').trim();
              const desc = (parts.slice(3).join(' ') || '').trim();
              if (!name || kb <= 0) continue;
              const id = `apt:${name}`;
              if (seen.has(id)) continue;
              seen.add(id);
              const sizeBytes = kb * 1024;
              programs.push({
                id,
                name,
                size: formatSize(sizeBytes),
                sizeBytes,
                source: 'APT',
                installCmd: `${isRootUser() ? '' : 'sudo '}apt install ${name}`,
                description: desc || 'Installed Debian/APT package.',
                powers: [],
                powersLoaded: false,
              });
            }
          } catch {
            // Ignore scanner failure
          }
        })()
      );
    }

    // --- 2. Arch Linux (pacman -Qi) ---
    if (hasPacman) {
      scanners.push(
        (async () => {
          try {
            const { stdout } = await execFileAsync('pacman', ['-Qi'], {
              maxBuffer: 48 * 1024 * 1024,
              timeout: 15000,
              env: { ...process.env, LC_ALL: 'C' },
            });
            const blocks = stdout.split(/\n\n+/);
            for (const block of blocks) {
              if (!block.trim()) continue;
              let name = '', desc = '', sizeBytes = 0, powers = [];
              for (const line of block.split('\n')) {
                const idx = line.indexOf(':');
                if (idx === -1) continue;
                const key = line.slice(0, idx).trim();
                const val = line.slice(idx + 1).trim();
                if (key === 'Name') name = val;
                else if (key === 'Description') desc = val;
                else if (key === 'Installed Size') sizeBytes = parseHumanSizeToBytes(val);
                else if (key === 'Required By' && val && val !== 'None') {
                  powers = val.split(/\s+/).filter(Boolean);
                }
              }
              if (!name || sizeBytes <= 0) continue;
              const id = `pacman:${name}`;
              if (seen.has(id)) continue;
              seen.add(id);
              powersCache.set(id, powers);
              programs.push({
                id,
                name,
                size: formatSize(sizeBytes),
                sizeBytes,
                source: 'PACMAN',
                installCmd: `${isRootUser() ? '' : 'sudo '}pacman -S ${name}`,
                description: desc || 'Installed Arch Linux package.',
                powers,
                powersLoaded: true,
              });
            }
          } catch {
            // Ignore scanner failure
          }
        })()
      );
    }

    // --- 3. Fedora / RHEL / CentOS / openSUSE (rpm) ---
    if (hasRpm && !hasDpkg) {
      scanners.push(
        (async () => {
          try {
            const { stdout } = await execFileAsync(
              'rpm',
              ['-qa', '--qf', '%{SIZE}\t%{NAME}\t%{SUMMARY}\n'],
              { maxBuffer: 32 * 1024 * 1024, timeout: 15000 }
            );
            for (const line of stdout.split('\n')) {
              if (!line) continue;
              const parts = line.split('\t');
              if (parts.length < 2) continue;
              const sizeBytes = parseInt(parts[0], 10) || 0;
              const name = (parts[1] || '').trim();
              const desc = (parts.slice(2).join(' ') || '').trim();
              if (!name || sizeBytes <= 0) continue;
              const id = `rpm:${name}`;
              if (seen.has(id)) continue;
              seen.add(id);
              programs.push({
                id,
                name,
                size: formatSize(sizeBytes),
                sizeBytes,
                source: 'RPM',
                installCmd: `${isRootUser() ? '' : 'sudo '}dnf install ${name}`,
                description: desc || 'Installed RPM package.',
                powers: [],
                powersLoaded: false,
              });
            }
          } catch {
            // Ignore scanner failure
          }
        })()
      );
    }

    // --- 4. Alpine Linux (apk) ---
    if (hasApk) {
      scanners.push(
        (async () => {
          try {
            const [sizeRes, descRes] = await Promise.all([
              execFileAsync('apk', ['info', '-s'], { maxBuffer: 16 * 1024 * 1024, timeout: 12000 }),
              execFileAsync('apk', ['info', '-d'], { maxBuffer: 16 * 1024 * 1024, timeout: 12000 }),
            ]);
            const descMap = new Map();
            for (const block of descRes.stdout.split(/\n\n+/)) {
              const lines = block.trim().split('\n');
              if (lines.length >= 2) {
                const name = lines[0].split(/\s+/)[0].replace(/-[0-9].*$/, '');
                descMap.set(name, lines[1].trim());
              }
            }
            for (const block of sizeRes.stdout.split(/\n\n+/)) {
              const lines = block.trim().split('\n');
              if (lines.length >= 2) {
                const rawName = lines[0].split(/\s+/)[0];
                const name = rawName.replace(/-[0-9].*$/, '');
                const sizeBytes = parseHumanSizeToBytes(lines[1].trim());
                if (!name || sizeBytes <= 0) continue;
                const id = `apk:${name}`;
                if (seen.has(id)) continue;
                seen.add(id);
                programs.push({
                  id,
                  name,
                  size: formatSize(sizeBytes),
                  sizeBytes,
                  source: 'APK',
                  installCmd: `${isRootUser() ? '' : 'sudo '}apk add ${name}`,
                  description: descMap.get(name) || 'Installed Alpine package.',
                  powers: [],
                  powersLoaded: false,
                });
              }
            }
          } catch {
            // Ignore scanner failure
          }
        })()
      );
    }

    // --- 5. Global NPM Packages ---
    if (hasNpm) {
      scanners.push(
        (async () => {
          try {
            const [rootRes, listRes] = await Promise.all([
              execFileAsync('npm', ['root', '-g'], { timeout: 6000 }),
              execFileAsync('npm', ['list', '-g', '--depth=0', '--json'], { maxBuffer: 8 * 1024 * 1024, timeout: 10000 }).catch((e) => ({ stdout: e.stdout || '{}' })),
            ]);
            const globalRoot = (rootRes.stdout || '').trim();
            const parsed = JSON.parse(listRes.stdout || '{}');
            const deps = parsed.dependencies || {};
            const names = Object.keys(deps);
            if (!names.length || !globalRoot) return;

            await Promise.all(
              names.map(async (pkgName) => {
                const pkgPath = path.join(globalRoot, pkgName);
                let sizeBytes = 0;
                let desc = 'Global Node.js / NPM package.';
                try {
                  const { stdout } = await execFileAsync('du', ['-sb', pkgPath], { timeout: 5000 });
                  sizeBytes = parseInt(stdout.split(/\s+/)[0], 10) || 0;
                } catch {
                  try {
                    const { stdout } = await execFileAsync('du', ['-sk', pkgPath], { timeout: 5000 });
                    sizeBytes = (parseInt(stdout.split(/\s+/)[0], 10) || 0) * 1024;
                  } catch {
                    sizeBytes = 0;
                  }
                }
                try {
                  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf8'));
                  if (pkgJson.description) desc = String(pkgJson.description);
                } catch {
                  // No package.json description
                }
                if (sizeBytes <= 0) return;
                const id = `npm:${pkgName}`;
                if (seen.has(id)) return;
                seen.add(id);
                powersCache.set(id, []);
                programs.push({
                  id,
                  name: pkgName,
                  size: formatSize(sizeBytes),
                  sizeBytes,
                  source: 'NPM',
                  installCmd: `npm install -g ${pkgName}`,
                  description: desc,
                  powers: [],
                  powersLoaded: true,
                });
              })
            );
          } catch {
            // Ignore npm scan error
          }
        })()
      );
    }

    await Promise.all(scanners);

    programs.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return programs;
  },

  async getPowers(program) {
    if (!program) return [];
    if (powersCache.has(program.id)) {
      program.powers = powersCache.get(program.id);
      program.powersLoaded = true;
      return program.powers;
    }

    let deps = [];
    try {
      if (program.source === 'APT') {
        const { stdout } = await execFileAsync(
          'apt-cache',
          ['rdepends', '--installed', program.name],
          { maxBuffer: 4 * 1024 * 1024, timeout: 6000 }
        );
        const set = new Set();
        for (const line of stdout.split('\n')) {
          const t = line.trim();
          if (!t || t.endsWith(':') || t === program.name || t.startsWith('Reverse Depends')) continue;
          const clean = t.replace(/^\|/, '').trim();
          if (clean && clean !== program.name) set.add(clean);
        }
        deps = Array.from(set);
      } else if (program.source === 'RPM') {
        const { stdout } = await execFileAsync(
          'rpm',
          ['-q', '--whatrequires', program.name],
          { maxBuffer: 4 * 1024 * 1024, timeout: 6000 }
        );
        deps = stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith('no package requires'));
      } else if (program.source === 'APK') {
        const { stdout } = await execFileAsync(
          'apk',
          ['info', '-r', program.name],
          { maxBuffer: 2 * 1024 * 1024, timeout: 6000 }
        );
        deps = stdout
          .split('\n')
          .slice(1)
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } catch {
      deps = [];
    }

    powersCache.set(program.id, deps);
    program.powers = deps;
    program.powersLoaded = true;
    return deps;
  },

  async deleteProgram(program) {
    if (!program || !program.name) return false;
    // Strict package name validation to prevent command injection
    if (!/^[a-zA-Z0-9@._/:+-]+$/.test(program.name)) return false;

    const useSudo = !isRootUser();
    const run = async (cmd, args, extraEnv = {}) => {
      const finalCmd = useSudo ? 'sudo' : cmd;
      const finalArgs = useSudo ? [cmd, ...args] : args;
      await execFileAsync(finalCmd, finalArgs, {
        timeout: 120000,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', ...extraEnv },
      });
    };

    try {
      if (program.source === 'APT') {
        await run('apt-get', ['remove', '-y', program.name]);
      } else if (program.source === 'PACMAN') {
        await run('pacman', ['-R', '--noconfirm', program.name]);
      } else if (program.source === 'RPM') {
        if (await cmdExists('dnf')) await run('dnf', ['remove', '-y', program.name]);
        else if (await cmdExists('yum')) await run('yum', ['remove', '-y', program.name]);
        else await run('rpm', ['-e', program.name]);
      } else if (program.source === 'APK') {
        await run('apk', ['del', program.name]);
      } else if (program.source === 'NPM') {
        await execFileAsync('npm', ['uninstall', '-g', program.name], { timeout: 120000 });
      } else {
        return false;
      }
      powersCache.delete(program.id);
      return true;
    } catch {
      return false;
    }
  },
};

// ============================================================================
// 2. 3-LINE PIXEL BLOCK FONT (ZERO EMOJIS)
// ============================================================================
const BIG_FONT = {
  A: ['▄▀▄', '█▀█', '▀ ▀'], B: ['█▀▄', '█▀▄', '▀▀ '], C: ['▄▀▀', '█  ', '▀▄▄'],
  D: ['█▀▄', '█ █', '▀▀ '], E: ['█▀▀', '█▀ ', '▀▀▀'], F: ['█▀▀', '█▀ ', '▀  '],
  G: ['▄▀▀', '█ ▀', '▀▄▄'], H: ['█ █', '█▀█', '▀ ▀'], I: ['▀█▀', ' █ ', '▀▀▀'],
  J: [' ▀█', '  █', '▀▀ '], K: ['█▄▀', '█▀▄', '▀ ▀'], L: ['█  ', '█  ', '▀▀▀'],
  M: ['█▄█', '█ █', '▀ ▀'], N: ['█▀█', '█ █', '▀ ▀'], O: ['▄▀▄', '█ █', '▀▄▀'],
  P: ['█▀▄', '█▀▀', '▀  '], Q: ['▄▀▄', '█▄█', ' ▀▄'], R: ['█▀▄', '█▀▄', '▀ ▀'],
  S: ['▄▀▀', '▀▀▄', '▄▄▀'], T: ['▀█▀', ' █ ', ' ▀ '], U: ['█ █', '█ █', '▀▄▀'],
  V: ['█ █', '█ █', ' ▀ '], W: ['█ █', '█▄█', '▀ ▀'], X: ['▀▄▀', ' █ ', '▄▀▄'],
  Y: ['█ █', ' ▀ ', ' ▀ '], Z: ['▀▀█', '▄▀ ', '▀▀▀'],
  '0': ['▄▀▄', '█ █', '▀▄▀'], '1': ['▄█ ', ' █ ', '▀▀▀'], '2': ['▀▀▄', '▄▀ ', '▀▀▀'],
  '3': ['▀▀▄', ' ▀▄', '▀▀ '], '4': ['█ █', '▀▀█', '  ▀'], '5': ['█▀▀', '▀▀▄', '▀▀ '],
  '6': ['▄▀▀', '█▀▄', '▀▄▀'], '7': ['▀▀█', '  █', '  ▀'], '8': ['▄▀▄', '█▀█', '▀▄▀'],
  '9': ['▄▀▄', '▀▀█', '▄▄▀'], '-': ['   ', '▀▀▀', '   '], '.': ['   ', '   ', ' ▄ '],
  '+': ['   ', '▄█▄', ' ▀ '], '_': ['   ', '   ', '▀▀▀'], ' ': ['  ', '  ', '  '],
};

function renderBigText(str, maxWidth) {
  const clean = str.toUpperCase().replace(/[^A-Z0-9\-.+_ ]/g, '');
  let r0 = '', r1 = '', r2 = '';
  for (const ch of clean) {
    const g = BIG_FONT[ch] || BIG_FONT[' '];
    const add = (r0 ? 1 : 0) + g[0].length;
    if (r0.length + add > maxWidth) break;
    r0 += (r0 ? ' ' : '') + g[0];
    r1 += (r1 ? ' ' : '') + g[1];
    r2 += (r2 ? ' ' : '') + g[2];
  }
  return [r0, r1, r2];
}

// ============================================================================
// 3. ANTHROPIC TRANSLUCENT COLOR WHEEL
// ============================================================================
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function translucentColorWheel(index, total = 10) {
  const hue = (14 + index * (360 / Math.max(6, total))) % 360;
  const [br, bg, bb] = hslToRgb(hue, 0.72, 0.66);
  const [tr, tg, tb] = hslToRgb(hue, 0.52, 0.09);
  return {
    borderFg: `\x1b[38;2;${br};${bg};${bb}m`,
    accentFg: `\x1b[38;2;${br};${bg};${bb}m`,
    tintBg: `\x1b[48;2;${tr};${tg};${tb}m`,
  };
}

// ============================================================================
// 4. SQUARIFIED TREEMAP ALGORITHM
// ============================================================================
function squarifyTreemap(items, x, y, w, h) {
  if (!items.length || w < 2 || h < 2) return [];
  // Cap rendered tiles per viewport so 1,000+ installed packages stay 60 FPS and crisp
  const maxTiles = Math.max(12, Math.min(60, Math.floor((w * h) / 28)));
  const sliced = items.slice(0, maxTiles);
  const totalVal = sliced.reduce((sum, it) => sum + Math.max(1, it.sizeBytes), 0);
  const normItems = sliced.map((it, idx) => ({
    ...it,
    _idx: idx,
    _area: (Math.max(1, it.sizeBytes) / totalVal) * (w * h * 2),
  }));

  const rects = [];
  let rx = x, ry = y, rw = w, rh = h;
  let remaining = normItems.slice();

  function worstRatio(row, sideLen) {
    if (!row.length || sideLen <= 0) return Infinity;
    const sum = row.reduce((a, b) => a + b._area, 0);
    const maxA = Math.max(...row.map((r) => r._area));
    const minA = Math.min(...row.map((r) => r._area));
    const s2 = sideLen * sideLen;
    return Math.max((s2 * maxA) / (sum * sum), (sum * sum) / (s2 * minA));
  }

  while (remaining.length > 0 && rw >= 1 && rh >= 1) {
    const horizontalSplit = rw >= rh * 2;
    const sideLen = horizontalSplit ? rh * 2 : rw;

    const row = [remaining.shift()];
    while (remaining.length > 0) {
      const next = remaining[0];
      if (worstRatio([...row, next], sideLen) <= worstRatio(row, sideLen)) {
        row.push(remaining.shift());
      } else {
        break;
      }
    }

    const rowArea = row.reduce((a, b) => a + b._area, 0);
    if (horizontalSplit) {
      const colW = Math.max(1, Math.min(rw, Math.round(rowArea / Math.max(1, rh * 2))));
      let curY = ry;
      row.forEach((it, i) => {
        const isLast = i === row.length - 1;
        const itemH = isLast ? (ry + rh - curY) : Math.max(1, Math.round((it._area / rowArea) * rh));
        if (itemH > 0) {
          rects.push({ x: rx, y: curY, w: colW, h: Math.min(itemH, ry + rh - curY), program: it, idx: it._idx });
          curY += itemH;
        }
      });
      rx += colW;
      rw -= colW;
    } else {
      const rowH = Math.max(1, Math.min(rh, Math.round(rowArea / Math.max(1, rw * 2))));
      let curX = rx;
      row.forEach((it, i) => {
        const isLast = i === row.length - 1;
        const itemW = isLast ? (rx + rw - curX) : Math.max(1, Math.round((it._area / rowArea) * rw));
        if (itemW > 0) {
          rects.push({ x: curX, y: ry, w: Math.min(itemW, rx + rw - curX), h: rowH, program: it, idx: it._idx });
          curX += itemW;
        }
      });
      ry += rowH;
      rh -= rowH;
    }
  }
  return rects;
}

// ============================================================================
// 5. 60 FPS SYNCHRONIZED DIFF-BUFFER RENDERER
// ============================================================================
class DiffScreen {
  constructor(w, h) {
    this.resize(w, h);
  }
  resize(w, h) {
    this.w = Math.max(20, Math.min(320, w || 40));
    this.h = Math.max(10, Math.min(140, h || 24));
    const size = this.w * this.h;
    this.currCh = new Array(size).fill(' ');
    this.currSt = new Array(size).fill('\x1b[49m\x1b[39m');
    this.prevCh = new Array(size).fill(null);
    this.prevSt = new Array(size).fill(null);
  }
  clear(bgStyle = '\x1b[49m\x1b[39m') {
    this.currCh.fill(' ');
    this.currSt.fill(bgStyle);
  }
  set(x, y, ch, style) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const idx = y * this.w + x;
    this.currCh[idx] = ch;
    this.currSt[idx] = style;
  }
  fillRect(x, y, w, h, ch, style) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const xEnd = Math.min(this.w, x + w);
    const yEnd = Math.min(this.h, y + h);
    for (let ry = Math.max(0, y); ry < yEnd; ry++) {
      const off = ry * this.w;
      for (let rx = Math.max(0, x); rx < xEnd; rx++) {
        this.currCh[off + rx] = ch;
        this.currSt[off + rx] = style;
      }
    }
  }
  writeText(x, y, text, style, maxX = this.w) {
    if (y < 0 || y >= this.h || !text) return;
    let cx = Math.round(x);
    const limit = Math.min(this.w, Math.round(maxX));
    for (let i = 0; i < text.length; i++) {
      if (cx >= limit) break;
      if (cx >= 0) {
        const idx = y * this.w + cx;
        this.currCh[idx] = text[i];
        this.currSt[idx] = style;
      }
      cx++;
    }
  }
  drawBox(x, y, w, h, borderStyle, fillStyle) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    if (w <= 0 || h <= 0) return;
    if (w < 2 || h < 2) {
      this.fillRect(x, y, w, h, ' ', fillStyle);
      return;
    }
    const x2 = x + w - 1;
    const y2 = y + h - 1;
    for (let ry = y; ry <= y2; ry++) {
      if (ry < 0 || ry >= this.h) continue;
      for (let rx = x; rx <= x2; rx++) {
        if (rx < 0 || rx >= this.w) continue;
        if (ry === y && rx === x) this.set(rx, ry, '╭', borderStyle);
        else if (ry === y && rx === x2) this.set(rx, ry, '╮', borderStyle);
        else if (ry === y2 && rx === x) this.set(rx, ry, '╰', borderStyle);
        else if (ry === y2 && rx === x2) this.set(rx, ry, '╯', borderStyle);
        else if (ry === y || ry === y2) this.set(rx, ry, '─', borderStyle);
        else if (rx === x || rx === x2) this.set(rx, ry, '│', borderStyle);
        else this.set(rx, ry, ' ', fillStyle);
      }
    }
  }
  drawHLine(x, y, w, style) {
    if (y < 0 || y >= this.h) return;
    for (let rx = Math.max(0, x); rx < Math.min(this.w, x + w); rx++) {
      this.set(rx, y, '─', style);
    }
  }
  flush(forceFullClear = false) {
    let out = forceFullClear ? '\x1b[2J' : '';
    let lastStyle = '';
    let cursorX = -1, cursorY = -1;

    for (let y = 0; y < this.h; y++) {
      const rowOff = y * this.w;
      for (let x = 0; x < this.w; x++) {
        const idx = rowOff + x;
        const ch = this.currCh[idx];
        const st = this.currSt[idx];
        if (!forceFullClear && ch === this.prevCh[idx] && st === this.prevSt[idx]) continue;

        this.prevCh[idx] = ch;
        this.prevSt[idx] = st;

        if (y !== cursorY || x !== cursorX) {
          out += `\x1b[${y + 1};${x + 1}H`;
          cursorY = y;
          cursorX = x;
        }
        if (st !== lastStyle) {
          out += st;
          lastStyle = st;
        }
        out += ch;
        cursorX++;
      }
    }
    if (out) {
      process.stdout.write('\x1b[?2026h' + out + RESET + '\x1b[?2026l');
    }
  }
}

// ============================================================================
// 6. THICK PHONE-STYLE VOLUME / DEPTH BAR (RIGHT EDGE)
// ============================================================================
function drawThickDepthSlider(screen, animRatio) {
  const barW = screen.w >= 60 ? 3 : 2;
  const startCol = screen.w - barW;
  const trackTop = Math.max(3, Math.floor(screen.h * 0.20));
  const trackBottom = Math.min(screen.h - 2, Math.floor(screen.h * 0.82));
  const trackH = Math.max(3, trackBottom - trackTop + 1);

  const trackBg = '\x1b[48;2;32;32;38m\x1b[38;2;56;56;66m';
  const fillBg = '\x1b[48;2;217;119;87m\x1b[38;2;245;210;190m';
  const capStyle = '\x1b[48;2;32;32;38m\x1b[38;2;217;119;87m';

  const clamped = Math.max(0, Math.min(1, animRatio));
  const fillRows = clamped * trackH;
  const fullCells = Math.floor(fillRows);
  const partial = fillRows - fullCells;

  for (let i = 0; i < trackH; i++) {
    const y = trackBottom - i;
    for (let dx = 0; dx < barW; dx++) {
      const col = startCol + dx;
      if (i < fullCells) {
        screen.set(col, y, '█', fillBg);
      } else if (i === fullCells && partial > 0.25) {
        const ch = partial > 0.65 ? '▆' : '▃';
        screen.set(col, y, ch, capStyle);
      } else {
        screen.set(col, y, '░', trackBg);
      }
    }
  }
}

// ============================================================================
// 7. RATIO-BASED DYNAMIC TEXT SCALING FOR TREEMAP TILES
// ============================================================================
function drawScaledTileContent(screen, box, palette, mapW, mapH) {
  const x = Math.round(box.x), y = Math.round(box.y);
  const w = Math.round(box.w), h = Math.round(box.h);
  const program = box.program;
  const innerW = w - 2;
  const innerH = h - 2;
  if (innerW < 2 || innerH < 1) return;

  const hasDeps = program.powers && program.powers.length > 0;
  const depGlyph = hasDeps ? ` ◈${program.powers.length}` : '';
  const whiteBold = palette.tintBg + '\x1b[38;2;246;244;238m' + BOLD;
  const accentBold = palette.tintBg + palette.accentFg + BOLD;
  const dimStyle = palette.tintBg + '\x1b[38;2;180;178;172m';

  const screenArea = Math.max(1, mapW * mapH);
  const boxAreaRatio = (w * h) / screenArea;

  // TIER 1 (HUGE BOX): 3-Line Pixel Block Font
  if (boxAreaRatio >= 0.14 && innerW >= 18 && innerH >= 7) {
    const bigLines = renderBigText(program.name, innerW - 2);
    const totalH = 5;
    const startY = y + 1 + Math.max(0, Math.floor((innerH - totalH) / 2));
    bigLines.forEach((line, idx) => {
      const px = x + 1 + Math.max(0, Math.floor((innerW - line.length) / 2));
      screen.writeText(px, startY + idx, line, whiteBold, x + w - 1);
    });
    const sub = `${program.size}${depGlyph}`.slice(0, innerW);
    const sx = x + 1 + Math.max(0, Math.floor((innerW - sub.length) / 2));
    screen.writeText(sx, startY + 4, sub, accentBold, x + w - 1);
    return;
  }

  // TIER 2 (MEDIUM BOX): Wide-Spaced Uppercase
  if (boxAreaRatio >= 0.05 && innerW >= 14 && innerH >= 4) {
    const wide = program.name.toUpperCase().split('').join(' ');
    const title = (wide.length <= innerW - 2 ? wide : program.name.toUpperCase()).slice(0, innerW);
    const sizeStr = `${program.size}${hasDeps ? ' ◈' : ''}`.slice(0, innerW);
    const midY = y + 1 + Math.floor((innerH - 2) / 2);
    screen.writeText(x + 1 + Math.floor((innerW - title.length) / 2), midY, title, whiteBold, x + w - 1);
    screen.writeText(x + 1 + Math.floor((innerW - sizeStr.length) / 2), midY + 1, sizeStr, accentBold, x + w - 1);
    return;
  }

  // TIER 3 (SMALL BOX): Stacked Name + Size
  if (innerW >= 6 && innerH >= 2) {
    const nameStr = program.name.slice(0, innerW);
    const sizeStr = program.size.slice(0, innerW);
    const midY = y + 1 + Math.floor((innerH - 2) / 2);
    screen.writeText(x + 1 + Math.floor((innerW - nameStr.length) / 2), midY, nameStr, whiteBold, x + w - 1);
    screen.writeText(x + 1 + Math.floor((innerW - sizeStr.length) / 2), midY + 1, sizeStr, accentBold, x + w - 1);
    return;
  }

  // TIER 4 (TINY BOX): Single line abbreviation
  const tiny = program.name.slice(0, innerW);
  const midY = y + 1 + Math.floor((innerH - 1) / 2);
  screen.writeText(x + 1 + Math.floor((innerW - tiny.length) / 2), midY, tiny, dimStyle, x + w - 1);
}

// ============================================================================
// 8. STATE, FAST 140ms CUBIC EASE-OUT TRANSITIONS & AMAZON-STYLE SEARCH/DETAIL
// ============================================================================
const screen = new DiffScreen(process.stdout.columns || 40, process.stdout.rows || 24);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;
const ANIM_MS = 140;
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

let state = {
  programs: [],
  totalBytes: 1,
  zoomOffset: 0,
  depthFrom: 0,
  depthTo: 0,
  animStart: 0,
  animFrom: new Map(),
  targetBoxes: [],
  view: 'map', // 'map' | 'card' | 'graph' | 'confirm' | 'search' | 'product'
  prevView: 'map',
  selectedProgram: null,
  searchQuery: '',
  searchSelectedIdx: 0,
  touchZones: [],
  cardBounds: null,
  dragStartX: null,
  dragStartY: null,
  isDragging: false,
  lastTapTime: 0,
  dirty: true,
  forceFullClear: false,
  resizeTimer: null,
  loading: false,
  loadingText: '',
  showSpinner: false,
  spinnerTick: 0,
  statusMsg: '',
  statusUntil: 0,
};

function getMapBounds() {
  const barW = screen.w >= 60 ? 3 : 2;
  const topHeaderH = 3;
  return {
    x: 0,
    y: topHeaderH,
    w: Math.max(8, screen.w - barW - 1),
    h: Math.max(4, screen.h - topHeaderH),
  };
}

function startBoxTransition(instant = false) {
  const mb = getMapBounds();
  const visible = state.programs.slice(state.zoomOffset);
  const nextTargets = squarifyTreemap(visible, mb.x, mb.y, mb.w, mb.h);

  if (instant) {
    state.targetBoxes = nextTargets;
    state.animFrom.clear();
    const maxOff = Math.max(1, state.programs.length - 1);
    state.depthFrom = state.zoomOffset / maxOff;
    state.depthTo = state.depthFrom;
    state.animStart = 0;
    state.dirty = true;
    return;
  }

  const now = Date.now();
  const prevT = state.animStart ? Math.min(1, (now - state.animStart) / ANIM_MS) : 1;
  const easedPrev = easeOutCubic(prevT);
  const snapshot = new Map();

  for (const tb of state.targetBoxes) {
    const from = state.animFrom.get(tb.program.id) || tb;
    snapshot.set(tb.program.id, {
      x: lerp(from.x, tb.x, easedPrev),
      y: lerp(from.y, tb.y, easedPrev),
      w: lerp(from.w, tb.w, easedPrev),
      h: lerp(from.h, tb.h, easedPrev),
    });
  }

  state.animFrom = snapshot;
  state.targetBoxes = nextTargets;
  state.depthFrom = lerp(state.depthFrom, state.depthTo, easedPrev);
  const maxOff = Math.max(1, state.programs.length - 1);
  state.depthTo = state.zoomOffset / maxOff;
  state.animStart = now;
  state.dirty = true;
}

function getFilteredPrograms() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.programs.slice(0, 12);
  return state.programs
    .filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.source && p.source.toLowerCase().includes(q))
    )
    .slice(0, 20);
}

function ensurePowersLoaded(program) {
  if (!program || program.powersLoaded || program._loadingPowers) return;
  program._loadingPowers = true;
  backend.getPowers(program).finally(() => {
    program._loadingPowers = false;
    state.dirty = true;
  });
}

// --- Render Top Bar (Minimal Search Trigger) ---
function drawTopSearchBar() {
  const barW = screen.w >= 60 ? 3 : 2;
  const maxW = Math.max(14, screen.w - barW - 1);
  const bg = '\x1b[48;2;18;18;22m';
  const border = bg + '\x1b[38;2;75;75;88m';
  const iconStyle = '\x1b[48;2;217;119;87m\x1b[38;2;14;14;18m' + BOLD;
  const placeholderStyle = bg + '\x1b[38;2;130;130;140m';
  const titleStyle = bg + '\x1b[38;2;235;232;226m' + BOLD;

  screen.drawBox(0, 0, maxW, 3, border, bg);

  const countTag = state.programs.length ? ` (${state.programs.length})` : '';
  const label = maxW >= 34
    ? `  DISK-TUI${countTag}  │  Search installed programs...`
    : '  Search programs...';
  screen.writeText(1, 1, label.slice(0, Math.max(4, maxW - 7)), placeholderStyle, maxW - 5);
  if (maxW >= 34) {
    screen.writeText(2, 1, `DISK-TUI${countTag}`, titleStyle, Math.min(maxW - 7, 12 + countTag.length));
  }

  const capW = Math.min(5, Math.max(3, maxW - 4));
  const capX = maxW - capW - 1;
  screen.writeText(capX, 1, capW >= 5 ? '  ⌕  ' : ' ⌕ ', iconStyle, maxW - 1);

  state.touchZones.push({ x: 0, y: 0, w: maxW, h: 3, action: 'OPEN_SEARCH' });
}

// --- Render Amazon-Style Search Dropdown Overlay ---
function drawSearchOverlay() {
  const bg = '\x1b[48;2;14;14;18m';
  const inputBg = '\x1b[48;2;24;24;30m';
  const borderFocus = inputBg + '\x1b[38;2;217;119;87m';
  const dropBorder = bg + '\x1b[38;2;70;70;82m';
  const iconCap = '\x1b[48;2;217;119;87m\x1b[38;2;14;14;18m' + BOLD;

  const sw = Math.max(24, Math.min(screen.w - 2, Math.min(110, Math.round(screen.w * 0.92))));
  const sx = Math.floor((screen.w - sw) / 2);
  const sy = 1;

  // 1. Search Input Box
  screen.drawBox(sx, sy, sw, 3, borderFocus, inputBg);
  const maxQueryLen = Math.max(6, sw - 14);
  const queryDisplay = state.searchQuery
    ? state.searchQuery.slice(-maxQueryLen) + '▎'
    : 'Type program name...';
  const qStyle = state.searchQuery
    ? inputBg + '\x1b[38;2;250;248;245m' + BOLD
    : inputBg + '\x1b[38;2;120;120;132m';
  screen.writeText(sx + 2, sy + 1, queryDisplay, qStyle, sx + sw - 10);

  if (state.searchQuery.length > 0 && sw >= 24) {
    screen.writeText(sx + sw - 9, sy + 1, ' × ', inputBg + '\x1b[38;2;180;180;190m' + BOLD);
    state.touchZones.push({ x: sx + sw - 10, y: sy, w: 4, h: 3, action: 'CLEAR_SEARCH' });
  }

  screen.writeText(sx + sw - 6, sy + 1, '  ⌕  ', iconCap, sx + sw - 1);
  state.touchZones.push({ x: sx + sw - 6, y: sy, w: 5, h: 3, action: 'SEARCH_SUBMIT' });

  // 2. Live Autocomplete Dropdown
  const results = getFilteredPrograms();
  const availDropH = Math.max(4, screen.h - 5);
  const maxRows = Math.max(1, Math.min(results.length || 1, Math.floor((availDropH - 2) / 2)));
  const dropH = Math.min(availDropH, maxRows * 2 + 2);
  const dropY = sy + 3;

  state.cardBounds = { x: sx, y: sy, w: sw, h: 3 + dropH };
  screen.drawBox(sx, dropY, sw, dropH, dropBorder, bg);

  if (results.length === 0) {
    screen.writeText(sx + 3, dropY + 1, 'No matching programs found on disk.', bg + '\x1b[38;2;150;150;160m', sx + sw - 2);
    return;
  }

  const qLower = state.searchQuery.trim().toLowerCase();
  for (let i = 0; i < maxRows; i++) {
    const prog = results[i];
    const ry = dropY + 1 + i * 2;
    if (ry >= dropY + dropH - 1) break;
    const isSel = i === state.searchSelectedIdx;
    const rowBg = isSel ? '\x1b[48;2;32;30;38m' : bg;

    if (isSel) screen.fillRect(sx + 1, ry, sw - 2, 1, ' ', rowBg);

    screen.writeText(sx + 2, ry, '⌕ ', rowBg + '\x1b[38;2;217;119;87m', sx + sw - 2);

    const name = prog.name;
    const matchIdx = qLower ? name.toLowerCase().indexOf(qLower) : -1;
    let cx = sx + 4;
    const maxNameX = Math.max(cx + 4, sx + sw - 12);
    if (matchIdx >= 0 && qLower.length > 0) {
      const before = name.slice(0, matchIdx);
      const mid = name.slice(matchIdx, matchIdx + qLower.length);
      const after = name.slice(matchIdx + qLower.length);
      screen.writeText(cx, ry, before, rowBg + '\x1b[38;2;190;190;198m', maxNameX);
      cx += before.length;
      screen.writeText(cx, ry, mid, rowBg + '\x1b[38;2;255;255;255m' + BOLD, maxNameX);
      cx += mid.length;
      screen.writeText(cx, ry, after, rowBg + '\x1b[38;2;190;190;198m', maxNameX);
    } else {
      screen.writeText(cx, ry, name, rowBg + '\x1b[38;2;245;242;236m' + BOLD, maxNameX);
    }

    const sizeLabel = prog.size;
    screen.writeText(sx + sw - sizeLabel.length - 3, ry, sizeLabel, rowBg + '\x1b[38;2;235;190;110m', sx + sw - 1);

    if (i < maxRows - 1 && ry + 1 < dropY + dropH - 1) {
      screen.drawHLine(sx + 2, ry + 1, sw - 4, bg + '\x1b[38;2;36;36;44m');
    }

    state.touchZones.push({ x: sx + 1, y: ry, w: sw - 2, h: 2, action: 'OPEN_PRODUCT', payload: prog });
  }
}

// --- Render Amazon-Style Program Detail Page ---
function drawProductPage() {
  const p = state.selectedProgram;
  if (!p) return;

  const bg = '\x1b[48;2;12;12;16m';
  const panelBg = '\x1b[48;2;20;20;26m';
  const border = panelBg + '\x1b[38;2;65;65;78m';
  const hasDeps = p.powers && p.powers.length > 0;
  const pct = ((p.sizeBytes / Math.max(1, state.totalBytes)) * 100).toFixed(1);
  const progIdx = Math.max(0, state.programs.findIndex((x) => x.id === p.id));
  const pal = translucentColorWheel(progIdx, Math.min(12, state.programs.length));

  screen.clear(bg);
  state.cardBounds = { x: 0, y: 0, w: screen.w, h: screen.h };

  // 1. Top Navigation Bar
  screen.drawBox(0, 0, screen.w, 3, border, panelBg);
  screen.writeText(2, 1, '‹ BACK', panelBg + '\x1b[38;2;217;119;87m' + BOLD, 10);
  state.touchZones.push({ x: 0, y: 0, w: 10, h: 3, action: 'CLOSE_PRODUCT' });

  if (screen.w >= 28) {
    screen.writeText(11, 1, '│  ⌕ Search another program...', panelBg + '\x1b[38;2;130;130;142m', screen.w - 2);
    state.touchZones.push({ x: 11, y: 0, w: screen.w - 11, h: 3, action: 'OPEN_SEARCH' });
  }

  const isWide = screen.w >= 72 && screen.h >= 16;
  const padX = 2;
  const curY = 4;

  // 2. Hero Tile Visual
  const heroW = isWide ? Math.min(64, Math.floor(screen.w * 0.36)) : screen.w - 4;
  const heroH = isWide ? Math.min(14, screen.h - 6) : Math.max(3, Math.min(7, Math.floor(screen.h * 0.22)));
  if (heroH >= 3 && heroW >= 8) {
    screen.drawBox(padX, curY, heroW, heroH, pal.tintBg + pal.borderFg, pal.tintBg);

    if (heroW >= 22 && heroH >= 7) {
      const big = renderBigText(p.name, heroW - 4);
      const by = curY + Math.max(1, Math.floor((heroH - 4) / 2));
      big.forEach((line, idx) => {
        const bx = padX + Math.max(1, Math.floor((heroW - line.length) / 2));
        screen.writeText(bx, by + idx, line, pal.tintBg + '\x1b[38;2;250;248;245m' + BOLD, padX + heroW - 1);
      });
      const tag = `${p.source || 'LINUX'} · ${p.size}`;
      screen.writeText(padX + Math.max(1, Math.floor((heroW - tag.length) / 2)), by + 3, tag, pal.tintBg + pal.accentFg + BOLD, padX + heroW - 1);
    } else {
      const title = p.name.toUpperCase().slice(0, Math.max(2, heroW - 4));
      const midY = curY + Math.floor(heroH / 2);
      screen.writeText(padX + Math.floor((heroW - title.length) / 2), midY, title, pal.tintBg + '\x1b[38;2;250;248;245m' + BOLD, padX + heroW - 1);
    }
  }

  // 3. Details & Action Column
  const colX = isWide ? padX + heroW + 2 : padX;
  const colW = Math.max(14, isWide ? Math.min(96, screen.w - colX - 2) : screen.w - 4);
  let infoY = isWide ? 4 : curY + heroH + 1;

  if (infoY < screen.h - 1) {
    screen.writeText(colX, infoY, p.name.toUpperCase(), bg + '\x1b[38;2;250;248;245m' + BOLD, colX + colW);
    infoY++;
  }
  if (infoY < screen.h - 1) {
    screen.writeText(colX, infoY, `${p.size}`, bg + '\x1b[38;2;235;190;110m' + BOLD, colX + colW);
    screen.writeText(colX + p.size.length + 2, infoY, `(${pct}% of tracked disk)`, bg + '\x1b[38;2;150;150;160m', colX + colW);
    infoY += 2;
  }

  // Action Pills
  if (hasDeps && infoY + 3 <= screen.h) {
    const depBtnStyle = '\x1b[48;2;32;56;78m\x1b[38;2;140;215;255m' + BOLD;
    screen.drawBox(colX, infoY, colW, 3, depBtnStyle, depBtnStyle);
    const label = `◈  INSPECT ${p.powers.length} DEPENDENT APPS`.slice(0, Math.max(4, colW - 4));
    screen.writeText(colX + Math.max(2, Math.floor((colW - label.length) / 2)), infoY + 1, label, depBtnStyle, colX + colW - 1);
    state.touchZones.push({ x: colX, y: infoY, w: colW, h: 3, action: 'OPEN_GRAPH' });
    infoY += 3;
  }

  if (infoY + 3 <= screen.h) {
    const delBtnStyle = '\x1b[48;2;78;28;38m\x1b[38;2;255;140;160m' + BOLD;
    screen.drawBox(colX, infoY, colW, 3, delBtnStyle, delBtnStyle);
    const label = `×  UNINSTALL ${p.name.toUpperCase()}`.slice(0, Math.max(4, colW - 4));
    screen.writeText(colX + Math.max(2, Math.floor((colW - label.length) / 2)), infoY + 1, label, delBtnStyle, colX + colW - 1);
    state.touchZones.push({ x: colX, y: infoY, w: colW, h: 3, action: 'ASK_DELETE' });
    infoY += 4;
  }

  // Specs Grid
  if (infoY + 2 < screen.h) {
    screen.drawHLine(colX, infoY, colW, bg + '\x1b[38;2;50;50;60m');
    infoY++;
    const lblSt = bg + '\x1b[38;2;145;145;155m';
    const valSt = bg + '\x1b[38;2;235;235;240m';
    const cmdSt = bg + '\x1b[38;2;130;212;158m';

    screen.writeText(colX, infoY, 'Source   ', lblSt, colX + colW);
    screen.writeText(colX + 9, infoY, p.source || 'LINUX', valSt, colX + colW);
    infoY++;

    if (infoY < screen.h - 1) {
      screen.writeText(colX, infoY, 'Install  ', lblSt, colX + colW);
      screen.writeText(colX + 9, infoY, p.installCmd.slice(0, Math.max(4, colW - 9)), cmdSt, colX + colW);
      infoY++;
    }

    if (infoY < screen.h - 1) {
      screen.writeText(colX, infoY, 'Impact   ', lblSt, colX + colW);
      const impact = !p.powersLoaded
        ? 'Checking reverse dependencies...'
        : hasDeps
          ? `Powers ${p.powers.length} apps (${p.powers.join(', ')})`
          : 'Standalone · Safe to remove';
      screen.writeText(colX + 9, infoY, impact.slice(0, Math.max(4, colW - 9)), hasDeps ? bg + '\x1b[38;2;235;190;110m' : valSt, colX + colW);
      infoY += 2;
    }

    if (p.description && infoY + 1 < screen.h) {
      screen.writeText(colX, infoY, 'About this program', bg + '\x1b[38;2;250;248;245m' + BOLD, colX + colW);
      infoY++;
      const lines = wrapText(`• ${p.description}`, colW, Math.max(1, screen.h - infoY - 1));
      lines.forEach((ln, i) => {
        screen.writeText(colX, infoY + i, ln, bg + '\x1b[38;2;185;185;195m', colX + colW);
      });
    }
  }
}

// --- Proportional Modal Cards (Content & buttons scale to fill the card!) ---
function wrapText(text, maxW, maxLines = 3) {
  if (!text || maxW < 4) return [];
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur ? cur.length + 1 : 0) + w.length <= maxW) {
      cur = cur ? cur + ' ' + w : w;
    } else {
      if (cur) lines.push(cur);
      cur = w.slice(0, maxW);
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

function drawProportionalModals() {
  const p = state.selectedProgram;
  if (!p) return;

  const hasDeps = p.powers && p.powers.length > 0;
  const cardBg = '\x1b[48;2;16;16;21m';
  const textMain = cardBg + '\x1b[38;2;248;246;242m' + BOLD;
  const textDim = cardBg + '\x1b[38;2;150;148;144m';
  const textAmber = cardBg + '\x1b[38;2;235;190;110m' + BOLD;
  const textGreen = cardBg + '\x1b[38;2;130;212;158m';
  const textBlue = cardBg + '\x1b[38;2;125;207;255m' + BOLD;
  const textRed = cardBg + '\x1b[38;2;247;118;142m' + BOLD;
  const divStyle = cardBg + '\x1b[38;2;48;48;58m';

  // 1. Proportional Info Card
  if (state.view === 'card') {
    const cw = Math.max(22, Math.min(screen.w - 4, Math.min(92, Math.round(screen.w * 0.72))));
    const isLarge = cw >= 42 && screen.h >= 22;
    const isTall = screen.h >= 28;
    const targetH = Math.round(screen.h * (isTall ? 0.48 : 0.50));
    const minH = Math.min(screen.h - 2, (isLarge ? 16 : 10) + (hasDeps ? 2 : 0));
    const maxH = Math.min(screen.h - 2, isLarge ? 26 : 16);
    const ch = Math.max(minH, Math.min(maxH, targetH));
    const cx = Math.floor((screen.w - cw) / 2);
    const cy = Math.floor((screen.h - ch) / 2);
    state.cardBounds = { x: cx, y: cy, w: cw, h: ch };

    screen.drawBox(cx, cy, cw, ch, cardBg + '\x1b[38;2;217;119;87m', cardBg);

    const padX = Math.max(2, Math.round(cw * 0.06));
    const innerW = Math.max(8, cw - padX * 2);
    const pct = Math.min(100, (p.sizeBytes / Math.max(1, state.totalBytes)) * 100);
    const pctStr = pct.toFixed(1) + '%';

    let curY = cy + (ch >= 18 ? 2 : 1);
    if (isLarge) {
      const big = renderBigText(p.name, innerW);
      big.forEach((line, idx) => {
        const bx = cx + Math.floor((cw - line.length) / 2);
        screen.writeText(bx, curY + idx, line, textMain, cx + cw - 2);
      });
      curY += 4;
      const sub = `${p.size}  ·  ${pctStr} OF DISK  ·  ${p.source || 'LINUX'}`.slice(0, innerW);
      screen.writeText(cx + Math.floor((cw - sub.length) / 2), curY, sub, textAmber, cx + cw - 2);
      curY += 2;
    } else {
      const title = p.name.toUpperCase().slice(0, innerW);
      screen.writeText(cx + Math.floor((cw - title.length) / 2), curY, title, textMain, cx + cw - 2);
      curY += 1;
      const sub = `${p.size} (${pctStr})`.slice(0, innerW);
      screen.writeText(cx + Math.floor((cw - sub.length) / 2), curY, sub, textAmber, cx + cw - 2);
      curY += 2;
    }

    if (ch >= 14) {
      const barW = Math.max(8, innerW);
      const filled = Math.max(1, Math.round((pct / 100) * barW));
      const barStr = '█'.repeat(filled) + '░'.repeat(Math.max(0, barW - filled));
      screen.writeText(cx + padX, curY, barStr.slice(0, filled), cardBg + '\x1b[38;2;217;119;87m', cx + cw - padX);
      screen.writeText(cx + padX + filled, curY, barStr.slice(filled), cardBg + '\x1b[38;2;52;52;62m', cx + cw - padX);
      curY += 2;
    }

    const usePillBtns = ch >= 19 && cw >= 32;
    const btnH = usePillBtns ? 3 : 1;
    const btnGap = 1;
    const totalBtnH = (hasDeps ? btnH + btnGap : 0) + btnH + 1;
    const btnStartY = Math.max(curY, cy + ch - totalBtnH);

    const availMidH = btnStartY - curY;
    if (availMidH >= 2) {
      screen.drawHLine(cx + padX, curY - 1, innerW, divStyle);
      const cmdPrefix = cw >= 34 ? 'Install  ' : '$ ';
      screen.writeText(cx + padX, curY, cmdPrefix, textDim, cx + cw - padX);
      screen.writeText(
        cx + padX + cmdPrefix.length,
        curY,
        p.installCmd.slice(0, Math.max(4, innerW - cmdPrefix.length)),
        textGreen,
        cx + cw - padX
      );
      curY += 2;
    }

    if (p.description && btnStartY - curY >= 2) {
      const maxDescLines = Math.min(3, btnStartY - curY - 1);
      const descLines = wrapText(p.description, innerW, maxDescLines);
      descLines.forEach((line, idx) => {
        screen.writeText(cx + padX, curY + idx, line, textDim, cx + cw - padX);
      });
    }

    let by = btnStartY;
    if (hasDeps) {
      const depLabel = (cw >= 34 ? `◈  INSPECT ${p.powers.length} DEPENDENT APPS` : `◈ DEPS (${p.powers.length})`).slice(0, innerW - 2);
      if (usePillBtns) {
        const depBtnStyle = '\x1b[48;2;28;48;68m\x1b[38;2;135;212;255m' + BOLD;
        screen.drawBox(cx + padX, by, innerW, 3, depBtnStyle, depBtnStyle);
        screen.writeText(cx + padX + Math.max(1, Math.floor((innerW - depLabel.length) / 2)), by + 1, depLabel, depBtnStyle, cx + cw - padX - 1);
        state.touchZones.push({ x: cx + padX, y: by, w: innerW, h: 3, action: 'OPEN_GRAPH' });
        by += 4;
      } else {
        screen.writeText(cx + Math.floor((cw - depLabel.length) / 2), by, depLabel, textBlue, cx + cw - 2);
        state.touchZones.push({ x: cx + 1, y: by - 1, w: cw - 2, h: 2, action: 'OPEN_GRAPH' });
        by += 2;
      }
    }

    const delLabel = (cw >= 30 ? `×  DELETE ${p.name.toUpperCase()}` : `× DELETE`).slice(0, innerW - 2);
    if (usePillBtns) {
      const delBtnStyle = '\x1b[48;2;72;26;36m\x1b[38;2;255;135;155m' + BOLD;
      screen.drawBox(cx + padX, by, innerW, 3, delBtnStyle, delBtnStyle);
      screen.writeText(cx + padX + Math.max(1, Math.floor((innerW - delLabel.length) / 2)), by + 1, delLabel, delBtnStyle, cx + cw - padX - 1);
      state.touchZones.push({ x: cx + padX, y: by, w: innerW, h: 3, action: 'ASK_DELETE' });
    } else {
      screen.writeText(cx + Math.floor((cw - delLabel.length) / 2), by, delLabel, textRed, cx + cw - 2);
      state.touchZones.push({ x: cx + 1, y: by - 1, w: cw - 2, h: 2, action: 'ASK_DELETE' });
    }
  }

  // 2. Proportional Dependency Graph
  if (state.view === 'graph') {
    const gw = Math.max(22, Math.min(screen.w - 2, Math.min(100, Math.round(screen.w * 0.84))));
    const gh = Math.max(10, Math.min(screen.h - 2, Math.min(34, Math.round(screen.h * 0.58))));
    const gx = Math.floor((screen.w - gw) / 2);
    const gy = Math.floor((screen.h - gh) / 2);
    state.cardBounds = { x: gx, y: gy, w: gw, h: gh };

    screen.drawBox(gx, gy, gw, gh, cardBg + '\x1b[38;2;125;207;255m', cardBg);
    const header = `◈ POWERED BY ${p.name.toUpperCase()}`.slice(0, gw - 4);
    screen.writeText(gx + Math.floor((gw - header.length) / 2), gy + 1, header, textBlue, gx + gw - 1);

    const centerY = gy + Math.floor(gh / 2);
    const centerLabel = ` ${p.name} `.slice(0, gw - 6);
    const centerX = gx + Math.floor((gw - centerLabel.length) / 2);
    screen.writeText(centerX, centerY, centerLabel, '\x1b[48;2;217;119;87m\x1b[38;2;15;15;18m' + BOLD, gx + gw - 1);

    const deps = p.powers || [];
    const offsets = [-4, 4, -2, 2, -6, 6, -8, 8];
    deps.forEach((depName, idx) => {
      const ty = centerY + (offsets[idx] || 0);
      if (ty <= gy + 2 || ty >= gy + gh - 2) return;
      if (gw >= 38) {
        const isLeft = idx % 2 === 0;
        const branch = isLeft ? `${depName} ──▶` : `◀── ${depName}`;
        const bx = isLeft
          ? Math.max(gx + 2, centerX - branch.length - 1)
          : Math.min(gx + gw - branch.length - 2, centerX + centerLabel.length + 1);
        screen.writeText(bx, ty, branch, textRed, gx + gw - 1);
      } else {
        const line = `└─ ${depName}`.slice(0, gw - 4);
        screen.writeText(gx + 2, ty, line, textRed, gx + gw - 1);
      }
    });

    const foot = 'Tap outside or press Esc to return'.slice(0, gw - 4);
    screen.writeText(gx + Math.floor((gw - foot.length) / 2), gy + gh - 2, foot, textDim, gx + gw - 1);
  }

  // 3. Proportional Delete Confirmation
  if (state.view === 'confirm') {
    const cw = Math.max(22, Math.min(screen.w - 4, Math.min(84, Math.round(screen.w * 0.72))));
    const minH = Math.min(screen.h - 2, hasDeps ? 10 : 7);
    const ch = Math.max(minH, Math.min(screen.h - 2, Math.min(15, Math.round(screen.h * 0.32))));
    const cx = Math.floor((screen.w - cw) / 2);
    const cy = Math.floor((screen.h - ch) / 2);
    state.cardBounds = { x: cx, y: cy, w: cw, h: ch };

    screen.drawBox(cx, cy, cw, ch, cardBg + '\x1b[38;2;247;118;142m', cardBg);
    const title = `Delete ${p.name} (${p.size})?`.slice(0, cw - 4);
    screen.writeText(cx + Math.floor((cw - title.length) / 2), cy + Math.min(2, Math.max(1, ch - 5)), title, textRed, cx + cw - 2);

    if (hasDeps && ch >= 9) {
      const midY = cy + Math.floor(ch / 2) - 1;
      const warn = (cw >= 38 ? 'This program powers these sub-programs:' : 'Powers these apps:').slice(0, cw - 4);
      screen.writeText(cx + Math.floor((cw - warn.length) / 2), midY, warn, textAmber, cx + cw - 2);
      const listStr = p.powers.join(', ').slice(0, cw - 6);
      screen.writeText(cx + Math.floor((cw - listStr.length) / 2), midY + 1, listStr, textMain, cx + cw - 2);
    }

    const btnY = cy + ch - (ch >= 9 ? 3 : 2);
    const yesTxt = cw >= 30 ? ' YES, DELETE ' : ' [YES] ';
    const noTxt = cw >= 30 ? '   CANCEL   ' : ' [NO] ';
    const halfW = Math.floor(cw / 2);

    const yesX = cx + Math.max(2, Math.floor((halfW - yesTxt.length) / 2));
    const noX = cx + halfW + Math.max(1, Math.floor((halfW - noTxt.length) / 2));

    screen.writeText(yesX, btnY, yesTxt, '\x1b[48;2;72;26;36m\x1b[38;2;255;140;160m' + BOLD, cx + halfW);
    state.touchZones.push({ x: cx + 1, y: btnY - 1, w: halfW - 1, h: 3, action: 'CONFIRM_DELETE' });

    screen.writeText(noX, btnY, noTxt, '\x1b[48;2;36;36;44m\x1b[38;2;210;210;220m' + BOLD, cx + cw - 1);
    state.touchZones.push({ x: cx + halfW, y: btnY - 1, w: cw - halfW - 1, h: 3, action: 'BACK_FROM_CONFIRM' });
  }
}

function drawLoadingPill() {
  if (!state.showSpinner) return;
  const spin = SPINNER_FRAMES[Math.floor(state.spinnerTick / 5) % SPINNER_FRAMES.length];
  const msg = ` ${spin}  ${state.loadingText || 'Scanning packages...'} `;
  const pw = Math.min(screen.w - 4, msg.length + 4);
  const ph = 3;
  const px = Math.floor((screen.w - pw) / 2);
  const py = Math.floor((screen.h - ph) / 2);
  const bg = '\x1b[48;2;18;18;24m';
  screen.drawBox(px, py, pw, ph, bg + '\x1b[38;2;217;119;87m', bg);
  screen.writeText(px + 2, py + 1, msg.slice(0, pw - 4), bg + '\x1b[38;2;245;242;235m' + BOLD, px + pw - 2);
}

function drawStatusToast() {
  if (!state.statusMsg || Date.now() > state.statusUntil) return;
  const msg = ` ${state.statusMsg} `;
  const tx = Math.max(1, Math.floor((screen.w - msg.length) / 2));
  const ty = Math.max(0, screen.h - 2);
  screen.writeText(tx, ty, msg.slice(0, screen.w - 2), '\x1b[48;2;32;32;40m\x1b[38;2;235;190;110m' + BOLD, screen.w - 1);
}

// ============================================================================
// 9. MAIN 60 FPS RENDER TICK
// ============================================================================
function stepAndRender() {
  const now = Date.now();
  const rawT = state.animStart ? Math.min(1, (now - state.animStart) / ANIM_MS) : 1;
  const eased = easeOutCubic(rawT);
  const animating = rawT < 1;

  if (state.showSpinner) {
    state.spinnerTick++;
    if (state.spinnerTick % 5 === 0) state.dirty = true;
  }
  if (state.statusMsg && now > state.statusUntil) {
    state.statusMsg = '';
    state.dirty = true;
  }

  if (!state.dirty && !animating) return;
  state.dirty = animating;

  state.touchZones = [];
  state.cardBounds = null;

  if (state.view === 'product') {
    drawProductPage();
    drawLoadingPill();
    drawStatusToast();
    screen.flush(state.forceFullClear);
    state.forceFullClear = false;
    return;
  }

  screen.clear('\x1b[49m\x1b[39m');

  // 1. Top Search Bar
  drawTopSearchBar();

  // 2. Animated Squarified Treemap
  const mb = getMapBounds();
  for (const tb of state.targetBoxes) {
    const from = state.animFrom.get(tb.program.id);
    const b = from && animating
      ? {
          x: lerp(from.x, tb.x, eased),
          y: lerp(from.y, tb.y, eased),
          w: lerp(from.w, tb.w, eased),
          h: lerp(from.h, tb.h, eased),
          program: tb.program,
          idx: tb.idx,
        }
      : tb;

    const pal = translucentColorWheel(state.zoomOffset + tb.idx, Math.min(12, Math.max(6, state.programs.length)));
    screen.drawBox(b.x, b.y, b.w, b.h, pal.tintBg + pal.borderFg, pal.tintBg);
    drawScaledTileContent(screen, b, pal, mb.w, mb.h);
  }

  // 3. Thick Phone-Style Depth / Volume Bar
  const curDepth = lerp(state.depthFrom, state.depthTo, eased);
  drawThickDepthSlider(screen, curDepth);

  // 4. Overlays (Search or Proportional Modals)
  if (state.view === 'search') {
    drawSearchOverlay();
  } else if (state.view !== 'map') {
    drawProportionalModals();
  }

  drawLoadingPill();
  drawStatusToast();

  screen.flush(state.forceFullClear);
  state.forceFullClear = false;
}

// ============================================================================
// 10. ACTIONS, TOUCH & KEYBOARD HANDLERS (PHONES + LAPTOPS)
// ============================================================================
function showToast(msg, ms = 2200) {
  state.statusMsg = msg;
  state.statusUntil = Date.now() + ms;
  state.dirty = true;
}

async function triggerAction(action, payload) {
  if (action === 'ZOOM_IN' && state.zoomOffset < state.programs.length - 1) {
    state.zoomOffset++;
    startBoxTransition(false);
    return;
  } else if (action === 'ZOOM_OUT' && state.zoomOffset > 0) {
    state.zoomOffset--;
    startBoxTransition(false);
    return;
  } else if (action === 'OPEN_SEARCH') {
    state.prevView = state.view === 'product' ? 'product' : 'map';
    state.view = 'search';
    state.searchSelectedIdx = 0;
  } else if (action === 'CLEAR_SEARCH') {
    state.searchQuery = '';
    state.searchSelectedIdx = 0;
  } else if (action === 'SEARCH_SUBMIT') {
    const results = getFilteredPrograms();
    if (results.length > 0) {
      state.selectedProgram = results[Math.min(state.searchSelectedIdx, results.length - 1)];
      ensurePowersLoaded(state.selectedProgram);
      state.view = 'product';
    }
  } else if (action === 'OPEN_PRODUCT' && payload) {
    state.selectedProgram = payload;
    ensurePowersLoaded(state.selectedProgram);
    state.view = 'product';
  } else if (action === 'CLOSE_PRODUCT') {
    state.view = 'map';
    state.selectedProgram = null;
  } else if (action === 'CLOSE_MODAL') {
    state.view = 'map';
    state.selectedProgram = null;
  } else if (action === 'OPEN_GRAPH') {
    state.prevView = state.view;
    ensurePowersLoaded(state.selectedProgram);
    state.view = 'graph';
  } else if (action === 'ASK_DELETE') {
    state.prevView = state.view;
    ensurePowersLoaded(state.selectedProgram);
    state.view = 'confirm';
  } else if (action === 'BACK_FROM_CONFIRM') {
    state.view = state.prevView === 'product' ? 'product' : 'card';
  } else if (action === 'CONFIRM_DELETE' && state.selectedProgram && !state.loading) {
    const target = state.selectedProgram;
    state.loading = true;
    state.loadingText = `Removing ${target.name}...`;
    state.showSpinner = true;
    state.dirty = true;

    const ok = await backend.deleteProgram(target);

    state.loading = false;
    state.showSpinner = false;
    if (ok) {
      state.programs = state.programs.filter((item) => item.id !== target.id);
      state.totalBytes = state.programs.reduce((s, x) => s + Math.max(1, x.sizeBytes), 0);
      if (state.zoomOffset >= state.programs.length) state.zoomOffset = Math.max(0, state.programs.length - 1);
      state.view = 'map';
      state.selectedProgram = null;
      showToast(`Removed ${target.name} (${target.size})`);
      startBoxTransition(false);
    } else {
      state.view = state.prevView === 'product' ? 'product' : 'card';
      showToast(`Failed to remove ${target.name} (check permissions/deps)`, 3000);
    }
    return;
  }
  state.dirty = true;
}

function handleTap(col, row) {
  if (state.loading) return;
  const x = col - 1, y = row - 1;
  const now = Date.now();
  if (state.view === 'map' && x >= screen.w - 3 && y <= 2 && now - state.lastTapTime < 450) {
    cleanupAndExit();
  }
  state.lastTapTime = now;

  for (let i = state.touchZones.length - 1; i >= 0; i--) {
    const z = state.touchZones[i];
    if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) {
      triggerAction(z.action, z.payload);
      return;
    }
  }

  if (state.view !== 'map' && state.view !== 'product') {
    if (state.cardBounds) {
      const b = state.cardBounds;
      if (x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h) {
        if (state.view === 'graph' || state.view === 'confirm') {
          state.view = state.prevView === 'product' ? 'product' : 'card';
        } else {
          state.view = 'map';
          state.selectedProgram = null;
        }
        state.dirty = true;
        return;
      }
    }
    return;
  }

  if (state.view === 'map') {
    for (const b of state.targetBoxes) {
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
        state.selectedProgram = b.program;
        ensurePowersLoaded(state.selectedProgram);
        state.view = 'card';
        state.dirty = true;
        return;
      }
    }
  }
}

function cleanupAndExit() {
  process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?1049l');
  process.exit(0);
}

async function main() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l');

  // Start 60 FPS loop immediately so loading indicator is non-blocking
  setInterval(stepAndRender, 16);

  // Show minimal spinner only if scan takes >200ms
  state.loading = true;
  state.loadingText = 'Scanning installed packages...';
  const spinDelay = setTimeout(() => {
    if (state.loading) {
      state.showSpinner = true;
      state.dirty = true;
    }
  }, 200);

  process.stdout.on('resize', () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      screen.resize(process.stdout.columns || 40, process.stdout.rows || 24);
      startBoxTransition(true);
      state.forceFullClear = true;
      state.dirty = true;
    }, 25);
  });

  process.stdin.on('data', (buf) => {
    const str = buf.toString();
    let matchedMouse = false;

    for (const match of str.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      matchedMouse = true;
      const btn = Number(match[1]), col = Number(match[2]), row = Number(match[3]), phase = match[4];

      if (btn === 64 && phase === 'M' && state.view === 'map') { triggerAction('ZOOM_OUT'); continue; }
      if (btn === 65 && phase === 'M' && state.view === 'map') { triggerAction('ZOOM_IN'); continue; }

      if (btn === 0 && phase === 'M') {
        state.dragStartX = col; state.dragStartY = row; state.isDragging = false;
        continue;
      }

      if (btn === 32 && phase === 'M' && state.dragStartY !== null) {
        const dy = row - state.dragStartY, dx = col - state.dragStartX;
        if (Math.abs(dy) >= 2 && state.view === 'map') {
          state.isDragging = true;
          state.dragStartY = row;
          triggerAction(dy > 0 ? 'ZOOM_IN' : 'ZOOM_OUT');
        } else if (dx <= -14 && state.view === 'map') {
          cleanupAndExit();
        }
        continue;
      }

      if (btn === 0 && phase === 'm') {
        if (!state.isDragging) handleTap(col, row);
        state.dragStartY = null; state.isDragging = false;
      }
    }

    if (matchedMouse) return;

    if (str === '\x03') cleanupAndExit();
    if (state.loading) return;

    // Keyboard input for Search mode
    if (state.view === 'search') {
      if (str === '\x1b') { state.view = state.prevView || 'map'; state.dirty = true; }
      else if (str === '\r' || str === '\n') triggerAction('SEARCH_SUBMIT');
      else if (str === '\x7f' || str === '\b') {
        state.searchQuery = state.searchQuery.slice(0, -1);
        state.searchSelectedIdx = 0;
        state.dirty = true;
      } else if (str === '\x1b[A') {
        state.searchSelectedIdx = Math.max(0, state.searchSelectedIdx - 1);
        state.dirty = true;
      } else if (str === '\x1b[B') {
        const len = getFilteredPrograms().length;
        state.searchSelectedIdx = Math.min(Math.max(0, len - 1), state.searchSelectedIdx + 1);
        state.dirty = true;
      } else if (str.length === 1 && str >= ' ' && str <= '~') {
        state.searchQuery += str;
        state.searchSelectedIdx = 0;
        state.dirty = true;
      }
      return;
    }

    // Universal desktop/laptop + phone keyboard controls
    if (str === 'q') cleanupAndExit();
    else if (str === '/') triggerAction('OPEN_SEARCH');
    else if (str === '\x1b') {
      if (state.view === 'graph' || state.view === 'confirm') {
        state.view = state.prevView === 'product' ? 'product' : 'card';
      } else {
        state.view = 'map';
        state.selectedProgram = null;
      }
      state.dirty = true;
    } else if (state.view === 'map') {
      if (str === '\x1b[B' || str === '\x1b[C' || str === '+' || str === '=') triggerAction('ZOOM_IN');
      else if (str === '\x1b[A' || str === '\x1b[D' || str === '-' || str === '_') triggerAction('ZOOM_OUT');
      else if ((str === '\r' || str === '\n') && state.targetBoxes.length > 0) {
        state.selectedProgram = state.targetBoxes[0].program;
        ensurePowersLoaded(state.selectedProgram);
        state.view = 'card';
        state.dirty = true;
      }
    } else if (state.view === 'confirm') {
      if (str === 'y' || str === 'Y' || str === '\r' || str === '\n') triggerAction('CONFIRM_DELETE');
      else if (str === 'n' || str === 'N') triggerAction('BACK_FROM_CONFIRM');
    }
  });

  // Load real packages asynchronously
  state.programs = await backend.getPrograms();
  clearTimeout(spinDelay);
  state.loading = false;
  state.showSpinner = false;
  state.totalBytes = state.programs.reduce((s, x) => s + Math.max(1, x.sizeBytes), 0);

  if (state.programs.length === 0) {
    showToast('No supported package managers found (apt/pacman/rpm/apk/npm)', 4000);
  }
  startBoxTransition(true);
}

main();
