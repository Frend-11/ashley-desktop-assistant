import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolveCoarseLocationByIp } from './ip-location';
import os from 'node:os';
import path from 'node:path';
import type { WeatherCoordinates } from './weather';

export type LinuxSessionType = 'wayland' | 'x11' | 'unknown';

let sessionType: LinuxSessionType | null = null;
let windowMonitorDegradedLogged = false;

export function detectSessionType(): LinuxSessionType {
  if (sessionType) return sessionType;
  const declared = process.env.XDG_SESSION_TYPE?.toLowerCase();
  if (declared === 'wayland') sessionType = 'wayland';
  else if (declared === 'x11') sessionType = 'x11';
  else if (process.env.WAYLAND_DISPLAY) sessionType = 'wayland';
  else if (process.env.DISPLAY) sessionType = 'x11';
  else sessionType = 'unknown';
  return sessionType;
}

function run(command: string, args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 256_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        reject(new Error(detail || `命令 ${command} 执行失败。`));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

// ---------------------------------------------------------------------------
// 应用名解析：GNOME 自带应用没有内联 Name[zh_CN]（走 gettext），所以中文名
// 必须自带映射；第三方应用普遍有，扫描 .desktop 文件兜底。
// ---------------------------------------------------------------------------

const knownApplicationCandidates: Record<string, string[]> = {
  设置: ['gnome-control-center.desktop', 'org.gnome.Settings.desktop'],
  系统设置: ['gnome-control-center.desktop', 'org.gnome.Settings.desktop'],
  文件: ['org.gnome.Nautilus.desktop', 'nautilus.desktop'],
  文件管理: ['org.gnome.Nautilus.desktop', 'nautilus.desktop'],
  文件管理器: ['org.gnome.Nautilus.desktop', 'nautilus.desktop'],
  访达: ['org.gnome.Nautilus.desktop', 'nautilus.desktop'],
  终端: ['org.gnome.Terminal.desktop', 'org.gnome.Console.desktop', 'ptyxis.desktop'],
  浏览器: ['firefox.desktop', 'org.mozilla.firefox.desktop'],
  火狐: ['firefox.desktop', 'org.mozilla.firefox.desktop'],
  计算器: ['org.gnome.Calculator.desktop', 'gnome-calculator.desktop'],
  文本编辑: ['org.gnome.gedit.desktop'],
  编辑器: ['org.gnome.gedit.desktop'],
  时钟: ['org.gnome.clocks.desktop'],
  天气: ['org.gnome.Weather.desktop'],
  日历: ['org.gnome.Calendar.desktop'],
  音乐: ['org.gnome.Music.desktop'],
  视频: ['org.gnome.Totem.desktop', 'org.gnome.Videos.desktop'],
  照片: ['org.gnome.Loupe.desktop', 'org.gnome.eog.desktop'],
  图像查看器: ['org.gnome.Loupe.desktop', 'org.gnome.eog.desktop'],
  软件中心: ['org.gnome.Software.desktop', 'gnome-software.desktop'],
  应用商店: ['org.gnome.Software.desktop', 'gnome-software.desktop'],
  截图: ['org.gnome.Screenshot.desktop'],
  微信: ['wechat.desktop', 'com.tencent.wechat.desktop', 'weixin.desktop'],
  网易云音乐: ['netease-cloud-music.desktop'],
  网易云: ['netease-cloud-music.desktop'],
  QQ: ['com.qq.QQ.desktop'],
  QQ音乐: ['qqmusic.desktop'],
  哔哩哔哩: ['bilibili.desktop'],
  哔哩: ['bilibili.desktop'],
  B站: ['bilibili.desktop']
};

type DesktopEntry = { id: string; file: string; names: Set<string> };

let desktopIndex: Map<string, DesktopEntry> | null = null;

function desktopSearchDirs(): string[] {
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return [...new Set([...dataDirs, dataHome])].map((dir) => path.join(dir, 'applications'));
}

function parseDesktopName(value: string) {
  // Value is already unescaped by GLib conventions for the fields we read.
  return value.trim();
}

function buildDesktopIndex(): Map<string, DesktopEntry> {
  const index = new Map<string, DesktopEntry>();
  for (const directory of desktopSearchDirs()) {
    let files: string[] = [];
    try {
      files = readdirSync(directory).filter((file) => file.endsWith('.desktop'));
    } catch {
      continue;
    }
    for (const file of files) {
      const id = file.replace(/\.desktop$/, '');
      const entry: DesktopEntry = { id, file: path.join(directory, file), names: new Set() };
      try {
        const content = readFileSync(entry.file, 'utf8');
        let hidden = false;
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === 'NoDisplay=true') hidden = true;
          if (trimmed === 'Hidden=true') hidden = true;
          const nameMatch = /^Name(?:\[([^\]]+)\])?\s*=\s*(.*)$/.exec(trimmed);
          if (nameMatch) {
            if (nameMatch[1] && nameMatch[1] !== 'zh_CN') continue;
            const name = parseDesktopName(nameMatch[2]);
            if (name) entry.names.add(name);
          }
        }
        if (hidden) continue;
      } catch {
        continue;
      }
      entry.names.add(id);
      index.set(id, entry);
    }
  }
  return index;
}

function getDesktopIndex(): Map<string, DesktopEntry> {
  if (!desktopIndex) desktopIndex = buildDesktopIndex();
  return desktopIndex;
}

function resolveDesktopEntry(rawName: string): DesktopEntry | null {
  const name = rawName.trim();
  if (!name) return null;
  const compact = name.replace(/\s/g, '');
  const index = getDesktopIndex();

  const candidates = knownApplicationCandidates[compact] ?? knownApplicationCandidates[name] ?? [];
  for (const candidate of candidates) {
    const entry = index.get(candidate.replace(/\.desktop$/, ''));
    if (entry) return entry;
  }

  for (const variant of [name, compact]) {
    for (const entry of index.values()) {
      if (entry.names.has(variant)) return entry;
    }
    const lower = variant.toLowerCase();
    for (const entry of index.values()) {
      if ([...entry.names].some((candidate) => candidate.toLowerCase() === lower)) return entry;
    }
  }

  // 用户直接说出 id（如 firefox、code），桌面文件同名即可启动。
  const direct = index.get(name.replace(/\.desktop$/, ''));
  if (direct) return direct;
  const compactDirect = index.get(compact);
  if (compactDirect) return compactDirect;

  return null;
}

export function openLinuxApplication(applicationName: string): Promise<void> {
  const entry = resolveDesktopEntry(applicationName);
  if (!entry) {
    return Promise.reject(new Error(`没有找到应用“${applicationName}”。请确认它已安装，或直接说出应用在启动器里的名称。`));
  }
  if (existsSync('/usr/bin/gtk-launch')) {
    return run('/usr/bin/gtk-launch', [entry.id], 10_000).then(() => undefined);
  }
  return run('/usr/bin/gio', ['launch', entry.file], 10_000).then(() => undefined);
}

// ---------------------------------------------------------------------------
// 窗口与应用关闭：X11 下 wmctrl 可用；Wayland 没有稳定的全局窗口 API，
// 明确报错而不是误杀进程。
// ---------------------------------------------------------------------------

function requireX11(what: string): never {
  const reason = detectSessionType() === 'x11'
    ? '没有找到 wmctrl 工具。'
    : '当前 Wayland 会话不允许读取或控制其他应用的窗口。';
  throw new Error(`${what}需要 X11 会话和 wmctrl 工具。${reason}请改用 Ubuntu 的 Xorg 会话，或在系统里手动操作。`);
}

type WmctrlWindow = { id: string; className: string; title: string };

function parseWmctrlWindows(stdout: string): WmctrlWindow[] {
  const windows: WmctrlWindow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\S+)\s+\S+\s+(.*)$/.exec(line.trim());
    if (match) windows.push({ id: match[1], className: match[3], title: match[4] });
  }
  return windows;
}

function classMatchCandidates(entry: DesktopEntry | null, rawName: string): string[] {
  const candidates: string[] = [];
  if (entry) {
    candidates.push(entry.id.toLowerCase());
    candidates.push((entry.id.split('.').pop() || entry.id).toLowerCase());
  }
  candidates.push(rawName.replace(/\s/g, '').toLowerCase(), rawName.toLowerCase());
  return candidates;
}

export async function closeLinuxApplication(applicationName: string): Promise<void> {
  if (detectSessionType() !== 'x11' || !existsSync('/usr/bin/wmctrl')) {
    requireX11('关闭其他应用');
    return;
  }
  const entry = resolveDesktopEntry(applicationName);
  const stdout = await run('/usr/bin/wmctrl', ['-lx']);
  const candidates = classMatchCandidates(entry, applicationName);
  const matches = parseWmctrlWindows(stdout).filter((window) =>
    candidates.some((candidate) =>
      candidate && (window.className.toLowerCase().includes(candidate) || candidate.includes(window.className.toLowerCase()))
    )
  );
  if (matches.length === 0) {
    throw new Error(`没有找到正在运行的“${applicationName}”。`);
  }
  for (const window of matches) {
    await run('/usr/bin/wmctrl', ['-ic', window.id]);
  }
}

export async function switchLinuxDesktop(destination: 'first' | 'second' | 'next' | 'previous'): Promise<string> {
  if (detectSessionType() !== 'x11' || !existsSync('/usr/bin/wmctrl')) {
    requireX11('切换工作区');
    return '';
  }
  const stdout = await run('/usr/bin/wmctrl', ['-d']);
  const lines = stdout.split('\n').filter((line) => line.trim());
  if (lines.length === 0) throw new Error('无法读取当前工作区。');
  let current = 0;
  lines.forEach((line, index) => {
    if (/^\d+\s+\*/.test(line.trim())) current = index;
  });
  const total = lines.length;

  let target: number;
  if (destination === 'first') target = 0;
  else if (destination === 'second') target = total >= 2 ? 1 : -1;
  else if (destination === 'next') target = current + 1 < total ? current + 1 : -1;
  else target = current - 1 >= 0 ? current - 1 : -1;

  if (target < 0) {
    throw new Error(destination === 'second' || destination === 'first'
      ? '没有那么多工作区。'
      : destination === 'next'
        ? '已经是最后一个工作区。'
        : '已经是第一个工作区。');
  }
  await run('/usr/bin/wmctrl', ['-s', String(target)]);
  return destination === 'second'
    ? '已切换到第二个工作区。'
    : destination === 'previous'
      ? '已切换到上一个工作区。'
      : '已切换到下一个工作区。';
}

export async function hasLinuxVisibleApplicationWindows(): Promise<boolean> {
  if (detectSessionType() !== 'x11' || !existsSync('/usr/bin/wmctrl')) {
    if (!windowMonitorDegradedLogged) {
      windowMonitorDegradedLogged = true;
      console.warn('[Ashley] 当前会话无法监测其他应用窗口（Wayland 或缺少 wmctrl）；头像将保持可见。');
    }
    return false;
  }
  const stdout = await run('/usr/bin/wmctrl', ['-lp'], 2_000);
  const ownPid = String(process.pid);
  return stdout.split('\n').some((line) => {
    const match = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s/.exec(line.trim());
    return Boolean(match && match[3] !== ownPid);
  });
}

export function playLinuxSystemSound(soundPath: string): Promise<void> {
  if (existsSync('/usr/bin/paplay')) return run('/usr/bin/paplay', [soundPath], 10_000).then(() => undefined);
  if (existsSync('/usr/bin/aplay')) return run('/usr/bin/aplay', ['-q', soundPath], 10_000).then(() => undefined);
  return Promise.reject(new Error('没有找到 paplay 或 aplay，无法播放音效。'));
}

export async function resolveCoarseLocationLinux(): Promise<WeatherCoordinates | null> {
  return resolveCoarseLocationByIp();
}

// ---------------------------------------------------------------------------
// 高德地图：uri.amap.com 的导航入口在桌面端会丢弃终点参数，直接使用
// ditu.amap.com 的网页版地址。
// ---------------------------------------------------------------------------

export function buildAmapSearchUrl(query: string): string {
  return `https://ditu.amap.com/search?query=${encodeURIComponent(query)}`;
}

export function buildAmapDirectionsUrl(
  destination: string,
  origin: WeatherCoordinates | null,
  mode: 'driving' | 'walking' | 'transit'
): string {
  const url = new URL('https://ditu.amap.com/route');
  if (origin) {
    // 高德的坐标顺序是 经度,纬度。
    url.searchParams.set('from', `${origin.longitude},${origin.latitude}`);
    url.searchParams.set('fromname', '我的位置');
  }
  url.searchParams.set('to', destination);
  url.searchParams.set('toname', destination);
  url.searchParams.set('type', mode === 'driving' ? 'car' : mode === 'walking' ? 'walk' : 'bus');
  return url.href;
}
