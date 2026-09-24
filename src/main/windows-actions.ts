import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { resolveCoarseLocationByIp } from './ip-location';
import type { WeatherCoordinates } from './weather';

// Windows platform actions, mirroring linux-actions.ts. Every Windows API
// call happens inside a long-lived Windows PowerShell 5.1 bridge process
// (src/native/windows-shell.ps1) that speaks one JSON line per command on
// stdin/stdout — see that file for the protocol. A persistent process is
// required because the avatar visibility monitor polls every 800 ms, which a
// per-call powershell.exe spawn (hundreds of milliseconds each) cannot bear.

type ShellResponse = {
  id?: number;
  ok?: boolean;
  ready?: boolean;
  error?: string;
  state?: string;
  apps?: Array<{ name: string; appId: string }>;
  target?: string;
  latitude?: number;
  longitude?: number;
  played?: boolean;
  title?: string;
  path?: string;
  steps?: string[];
};

interface PendingRequest {
  resolve: (value: ShellResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let shellChild: ChildProcess | null = null;
let shellStarting: Promise<ChildProcess> | null = null;
let shellDegradedLogged = false;
let nextCommandId = 1;
const pendingRequests = new Map<number, PendingRequest>();
let stdoutBuffer = '';
let stderrBuffer = '';

function resolvePowerShell() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function resolveNativeScript(fileName: string) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'native', fileName)
    : path.join(__dirname, '..', 'native', fileName);
}

function rejectAllPending(error: Error) {
  for (const request of pendingRequests.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pendingRequests.clear();
}

function handleShellLine(line: string) {
  if (!line.trim()) return;
  let payload: ShellResponse;
  try {
    payload = JSON.parse(line) as ShellResponse;
  } catch {
    return;
  }
  if (typeof payload.id !== 'number') return;
  const request = pendingRequests.get(payload.id);
  if (!request) return;
  pendingRequests.delete(payload.id);
  clearTimeout(request.timer);
  request.resolve(payload);
}

function handleShellExit() {
  shellChild = null;
  shellStarting = null;
  rejectAllPending(new Error('Windows shell bridge exited unexpectedly.'));
}

function startShell(): Promise<ChildProcess> {
  if (shellStarting) return shellStarting;
  shellStarting = new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(
      resolvePowerShell(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', resolveNativeScript('windows-shell.ps1'),
        String(process.pid)
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let readyLine = '';
    let settled = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      shellStarting = null;
      child.kill();
      reject(error);
    };

    child.on('error', (error) => fail(error));
    child.on('exit', () => {
      if (!settled) fail(new Error('Windows shell bridge exited before becoming ready.'));
      else handleShellExit();
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > 16_384) stderrBuffer = stderrBuffer.slice(-16_384);
    });
    child.stdout?.on('data', (chunk: string) => {
      if (!settled) {
        readyLine += chunk;
        const newlineIndex = readyLine.indexOf('\n');
        if (newlineIndex < 0) return;
        settled = true;
        let ready: ShellResponse;
        try {
          ready = JSON.parse(readyLine.slice(0, newlineIndex).trim()) as ShellResponse;
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (ready.ready !== true) {
          fail(new Error(ready.error || 'Windows shell bridge reported a startup error.'));
          return;
        }
        stdoutBuffer = readyLine.slice(newlineIndex + 1);
        shellChild = child;
        resolve(child);
        drainStdoutBuffer();
        return;
      }
      stdoutBuffer += chunk;
      drainStdoutBuffer();
    });
  });
  shellStarting.catch(() => undefined);
  return shellStarting;
}

function drainStdoutBuffer() {
  let newlineIndex = stdoutBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    handleShellLine(line);
    newlineIndex = stdoutBuffer.indexOf('\n');
  }
}

async function sendShellCommand(command: string, args: Record<string, unknown>, timeoutMs: number): Promise<ShellResponse> {
  let child: ChildProcess;
  try {
    child = await startShell();
  } catch (error) {
    throw new Error(`Windows shell bridge 不可用:${error instanceof Error ? error.message : String(error)}`);
  }
  const id = nextCommandId;
  nextCommandId += 1;
  return new Promise<ShellResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Windows shell bridge command ${command} timed out.`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer });
    child.stdin?.write(`${JSON.stringify({ id, cmd: command, args })}\n`, 'utf8', (error) => {
      if (error && pendingRequests.delete(id)) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

// The caller decides whether a dead bridge is fatal (user-initiated actions)
// or degradable (the passive window monitor). This helper keeps the monitor's
// failure mode aligned with the Linux Wayland one: warn once, stay visible.
export async function hasWindowsVisibleApplicationWindows(): Promise<boolean> {
  try {
    const response = await sendShellCommand('check', {}, 2_500);
    if (response.ok === false) throw new Error(response.error || 'check failed');
    return response.state === 'occupied';
  } catch (error) {
    if (!shellDegradedLogged) {
      shellDegradedLogged = true;
      console.warn('[Ashley] Windows 窗口监测不可用,头像将保持可见。', error);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// 应用名解析:Get-StartApps 同时返回桌面应用(.lnk 路径)和商店应用
// (shell:AppsFolder 的 PackageFamilyName!App),名称就是开始菜单里显示的
// 本地化名称,因此中文名直接说即可;别名表处理口头简称。
// ---------------------------------------------------------------------------

const knownApplicationAliases: Record<string, string> = {
  网易云: '网易云音乐',
  网易音乐: '网易云音乐',
  哔哩: '哔哩哔哩',
  B站: '哔哩哔哩',
  b站: '哔哩哔哩',
  酷狗: '酷狗音乐',
  腾讯会议: '腾讯会议',
  系统设置: '设置',
  设置: '设置'
};

let windowsAppIndex: Map<string, { name: string; appId: string }> | null = null;
let windowsAppIndexAt = 0;

async function getWindowsAppIndex(): Promise<Map<string, { name: string; appId: string }>> {
  if (windowsAppIndex && Date.now() - windowsAppIndexAt < 5 * 60_000) return windowsAppIndex;
  const response = await sendShellCommand('apps', {}, 15_000);
  if (response.ok === false) throw new Error(response.error || 'apps failed');
  const index = new Map<string, { name: string; appId: string }>();
  for (const entry of response.apps ?? []) {
    if (entry && typeof entry.name === 'string' && typeof entry.appId === 'string') {
      index.set(entry.name, { name: entry.name, appId: entry.appId });
    }
  }
  windowsAppIndex = index;
  windowsAppIndexAt = Date.now();
  return index;
}

async function resolveWindowsApplication(rawName: string): Promise<{ name: string; appId: string }> {
  const name = rawName.trim();
  if (!name) throw new Error('应用名称不能为空。');
  const index = await getWindowsAppIndex();
  const alias = knownApplicationAliases[name] ?? knownApplicationAliases[name.replace(/\s/g, '')];
  const candidates = alias ? [alias, name] : [name];
  for (const candidate of candidates) {
    const entry = index.get(candidate);
    if (entry) return entry;
  }
  const lower = name.toLowerCase();
  for (const entry of index.values()) {
    if (entry.name.toLowerCase() === lower) return entry;
  }
  throw new Error(`没有找到应用“${name}”。请确认它已安装,或直接说出它在开始菜单里的名称。`);
}

function explorerPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'explorer.exe');
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        reject(new Error(detail || `命令 ${command} 执行失败。`));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

export async function openWindowsApplication(applicationName: string): Promise<void> {
  const entry = await resolveWindowsApplication(applicationName);
  // 桌面应用:appId 是开始菜单 .lnk 的完整路径;商店应用:AppID 形如
  // PackageFamilyName!App,经 shell:AppsFolder 启动。
  const target = entry.appId.includes('!')
    ? `shell:AppsFolder\\${entry.appId}`
    : entry.appId;
  await run(explorerPath(), [target], 10_000);
}

export async function closeWindowsApplication(applicationName: string): Promise<void> {
  const entry = await resolveWindowsApplication(applicationName);
  if (entry.appId.includes('!')) {
    throw new Error(`“${entry.name}”是商店应用,请手动关闭。`);
  }
  const response = await sendShellCommand('resolve', { appId: entry.appId }, 8_000);
  if (response.ok === false) throw new Error(response.error || 'resolve failed');
  const target = (response.target ?? '').trim();
  if (!target || !/\.exe$/i.test(target)) {
    throw new Error(`无法确定“${entry.name}”的程序文件,请手动关闭。`);
  }
  const imageName = path.basename(target);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  try {
    await run(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/IM', imageName], 10_000);
  } catch {
    throw new Error(`没有找到正在运行的“${applicationName}”。`);
  }
}

export async function sendWindowsMediaKey(action: 'play_pause' | 'next' | 'previous'): Promise<void> {
  const response = await sendShellCommand('media', { key: action }, 3_000);
  if (response.ok === false) throw new Error(response.error || 'media failed');
}

export async function switchWindowsDesktop(destination: 'first' | 'second' | 'next' | 'previous'): Promise<void> {
  const response = await sendShellCommand('desktop', { destination }, 15_000);
  if (response.ok === false) throw new Error(response.error || 'desktop failed');
}

export function playWindowsSystemSound(soundPath: string): void {
  execFile(
    resolvePowerShell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', resolveNativeScript('play-sound.ps1'),
      '-Path', soundPath
    ],
    { timeout: 30_000 },
    (error) => {
      if (error) console.error(`[${new Date().toISOString()}] [Ashley] Unable to play assembly sound.`, error);
    }
  );
}

export async function resolveCoarseLocationWindows(): Promise<WeatherCoordinates | null> {
  try {
    const response = await sendShellCommand('location', {}, 30_000);
    if (response.ok === false) throw new Error(response.error || 'location failed');
    const latitude = Number(response.latitude);
    const longitude = Number(response.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude };
    }
  } catch {
    // Fall through to the IP lookup below, same behaviour as a denied
    // CoreLocation helper on macOS.
  }
  return resolveCoarseLocationByIp();
}

// ---------------------------------------------------------------------------
// 语音搜歌:驱动本机已登录的播放器客户端(与 macOS 的 AppleScript 方案同思路:
// 焦点窗口 → 点搜索框 → 剪贴板粘贴 → 回车 → 点第一个结果 → SMTC 确认播放)。
// 搜索框/结果的窗口内相对坐标在 music-automation.ps1 的配置表里,
// 用托盘菜单「音乐搜索调试」导出界面信息来校准。
// ---------------------------------------------------------------------------

export type WindowsMusicPlayer = 'netease' | 'kugou' | 'soda';

const windowsMusicPlayerDisplayNames: Record<WindowsMusicPlayer, string> = {
  netease: '网易云音乐',
  kugou: '酷狗音乐',
  soda: '汽水音乐'
};

export async function isWindowsMusicPlayerInstalled(player: WindowsMusicPlayer): Promise<boolean> {
  try {
    const index = await getWindowsAppIndex();
    return index.has(windowsMusicPlayerDisplayNames[player]);
  } catch {
    return false;
  }
}

export async function searchAndPlayWindowsMusic(
  player: WindowsMusicPlayer,
  query: string
): Promise<{ played: boolean; title: string | null; steps: string[] }> {
  const index = await getWindowsAppIndex();
  const entry = index.get(windowsMusicPlayerDisplayNames[player]);
  if (!entry) {
    throw new Error(`没有检测到${windowsMusicPlayerDisplayNames[player]}，请先安装后再试。`);
  }
  const launchAppId = entry.appId.includes('!') ? `shell:AppsFolder\\${entry.appId}` : entry.appId;
  const response = await sendShellCommand('music-search', { player, query, launchAppId }, 60_000);
  if (response.ok === false) throw new Error(response.error || 'music-search failed');
  return { played: response.played === true, title: response.title ?? null, steps: response.steps ?? [] };
}

export async function dumpWindowsMusicPlayerUi(player: WindowsMusicPlayer, outDir: string): Promise<string> {
  const response = await sendShellCommand('music-debug', { player, outDir }, 30_000);
  if (response.ok === false) throw new Error(response.error || 'music-debug failed');
  if (!response.path) throw new Error('music-debug returned no file path.');
  return response.path;
}
