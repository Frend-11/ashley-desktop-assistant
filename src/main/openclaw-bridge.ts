import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

// 委派任务给本机 OpenClaw CLI（openclaw agent）。CLI 通过 OpenClaw 网关
// （ws://127.0.0.1:18789）执行，任务在用户自己配置的智能体工作区里完成，
// 可能运行任意命令——启用即意味着信任本机 OpenClaw 的审批配置。
//
// 流式：每次运行都传入显式 session-id，使网关把会话事件实时追加到可预测的
// JSONL 文件里（OPENCLAW_STATE_DIR/agents/main/sessions/<id>.jsonl），
// 本模块在 CLI 运行期间轮询该文件，把工具调用、skill 调用和回复文本逐条
// 通过 onEvent 推给调用方，而不是等整个任务结束后一次性返回。

const CLI_SOFT_TIMEOUT_SECONDS = 600;
const HARD_TIMEOUT_MS = 660_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_POLL_INTERVAL_MS = 500;
const TAIL_DRAIN_QUIET_MS = 2_000;
const TAIL_DRAIN_MAX_MS = 10_000;
const MAX_REPLY_CHARS = 16_000;
const MAX_STDERR_CHARS = 500;
const MAX_DETAIL_CHARS = 300;
const MAX_SUMMARY_COMMAND_CHARS = 120;
const MAX_SUMMARY_COMMAND_EXAMPLES = 2;
const MAX_SUMMARY_COMMANDS = 5;
const SKILL_DIR_PATTERN = /(?:^|[\s/'"])skills\/([A-Za-z0-9._-]+)/g;

let cachedBin: string | null | undefined;

export function resolveOpenClawBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const candidates: string[] = [];
  const envBin = process.env.JARVIS_OPENCLAW_BIN?.trim();
  if (envBin) candidates.push(envBin);
  if (process.platform === 'win32') {
    candidates.push(
      path.join(homedir(), 'AppData', 'Roaming', 'npm', 'openclaw.cmd'),
      path.join(homedir(), 'AppData', 'Roaming', 'npm', 'openclaw.exe')
    );
  } else {
    candidates.push(
      path.join(homedir(), '.npm-global', 'bin', 'openclaw'),
      '/usr/local/bin/openclaw',
      '/usr/bin/openclaw'
    );
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      cachedBin = candidate;
      return candidate;
    } catch {
      // Keep looking through the candidates.
    }
  }
  const lookup = process.platform === 'win32'
    ? spawnSync('where', ['openclaw'], { encoding: 'utf8' })
    : spawnSync('command', ['-v', 'openclaw'], { encoding: 'utf8' });
  if (lookup.status === 0 && lookup.stdout.trim()) {
    const found = lookup.stdout.trim().split('\n')[0].trim();
    cachedBin = found;
    return found;
  }
  cachedBin = null;
  return null;
}

export function isOpenClawAvailable(): boolean {
  return resolveOpenClawBin() !== null;
}

interface OpenClawPayload {
  text?: unknown;
}

interface OpenClawResultJson {
  status?: unknown;
  summary?: unknown;
  result?: {
    payloads?: OpenClawPayload[];
    meta?: {
      agentMeta?: {
        sessionId?: unknown;
        sessionFile?: unknown;
      };
    };
  };
}

export type OpenClawStreamEvent =
  | { type: 'tool'; name: string; detail: string }
  | { type: 'skill'; name: string }
  | { type: 'text'; text: string };

export interface OpenClawTaskResult {
  reply: string;
  summary: string;
}

export interface RunOpenClawTaskOptions {
  userDataDir: string;
  onHeartbeat: (elapsedSeconds: number) => void;
  onEvent?: (event: OpenClawStreamEvent) => void;
}

interface StoredSession {
  sessionId: string;
  sessionFile: string | null;
}

function sessionStorePath(userDataDir: string): string {
  return path.join(userDataDir, 'openclaw-session.json');
}

function readStoredSession(userDataDir: string): StoredSession | null {
  const storePath = sessionStorePath(userDataDir);
  if (!existsSync(storePath)) return null;
  try {
    const stored = JSON.parse(readFileSync(storePath, 'utf8')) as {
      sessionId?: unknown;
      sessionFile?: unknown;
    };
    const sessionId = typeof stored.sessionId === 'string' && stored.sessionId ? stored.sessionId : '';
    const sessionFile = typeof stored.sessionFile === 'string' && stored.sessionFile ? stored.sessionFile : null;
    if (!sessionId) return null;
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}

function writeStoredSession(userDataDir: string, sessionId: string, sessionFile: string | null): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    sessionStorePath(userDataDir),
    JSON.stringify({ sessionId, sessionFile }),
    { encoding: 'utf8' }
  );
}

function clearStoredSessionId(userDataDir: string): void {
  rmSync(sessionStorePath(userDataDir), { force: true });
}

function sessionsDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homedir(), '.openclaw');
  return path.join(stateDir, 'agents', 'main', 'sessions');
}

interface RunStats {
  toolCounts: Record<string, number>;
  totalCommands: number;
  commands: string[];
  skills: string[];
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function recordCommand(stats: RunStats, command: string): void {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (!compact) return;
  stats.totalCommands += 1;
  const example = truncate(compact, MAX_SUMMARY_COMMAND_CHARS);
  if (!stats.commands.includes(example) && stats.commands.length < MAX_SUMMARY_COMMANDS) {
    stats.commands.push(example);
  }
}

function skillsIn(name: string, args: Record<string, unknown>): string[] {
  const skills = new Set<string>();
  if (name === 'skill' && typeof args.skill === 'string' && args.skill.trim()) {
    skills.add(args.skill.trim());
  }
  if (typeof args.command === 'string') {
    for (const match of args.command.matchAll(SKILL_DIR_PATTERN)) {
      skills.add(match[1]);
    }
  }
  return [...skills];
}

function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'exec': {
      const command = typeof args.command === 'string' ? args.command : '';
      return command ? `执行 ${truncate(command, MAX_DETAIL_CHARS)}` : `调用 ${name}`;
    }
    case 'process': {
      const command = typeof args.command === 'string' ? args.command : '';
      return command ? `执行 ${truncate(command, MAX_DETAIL_CHARS)}` : `调用 ${name}`;
    }
    case 'write': {
      const filePath =
        typeof args.path === 'string' ? args.path : typeof args.filePath === 'string' ? args.filePath : '';
      return filePath ? `写入文件 ${filePath}` : `调用 ${name}`;
    }
    case 'read': {
      const filePath =
        typeof args.path === 'string' ? args.path : typeof args.filePath === 'string' ? args.filePath : '';
      return filePath ? `读取文件 ${filePath}` : `调用 ${name}`;
    }
    case 'web_search':
      return typeof args.query === 'string' ? `搜索 ${truncate(args.query, MAX_DETAIL_CHARS)}` : `调用 ${name}`;
    case 'web_fetch':
      return typeof args.url === 'string' ? `抓取 ${args.url}` : `调用 ${name}`;
    default:
      return `调用 ${name}`;
  }
}

interface SessionContentItem {
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  text?: unknown;
}

interface SessionMessageLine {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

function processSessionLine(
  line: SessionMessageLine,
  stats: RunStats,
  emit: (event: OpenClawStreamEvent) => void
): void {
  if (line.type !== 'message') return;
  const message = line.message;
  if (!message || !Array.isArray(message.content)) return;
  for (const rawItem of message.content) {
    if (typeof rawItem !== 'object' || rawItem === null) continue;
    const item = rawItem as SessionContentItem;
    if (message.role === 'assistant' && item.type === 'toolCall') {
      const name = typeof item.name === 'string' && item.name ? item.name : 'unknown';
      const args =
        item.arguments && typeof item.arguments === 'object'
          ? (item.arguments as Record<string, unknown>)
          : {};
      stats.toolCounts[name] = (stats.toolCounts[name] ?? 0) + 1;
      const detail = describeToolCall(name, args);
      emit({ type: 'tool', name, detail });
      if (typeof args.command === 'string') recordCommand(stats, args.command);
      for (const skill of skillsIn(name, args)) {
        if (!stats.skills.includes(skill)) stats.skills.push(skill);
        emit({ type: 'skill', name: skill });
      }
    } else if (message.role === 'assistant' && item.type === 'text') {
      if (typeof item.text === 'string' && item.text.trim()) {
        emit({ type: 'text', text: item.text });
      }
    }
  }
}

function startSessionTail(
  filePath: string,
  stats: RunStats,
  emit: (event: OpenClawStreamEvent) => void
): { stop: () => void; lastDataAt: () => number } {
  let offset = 0;
  try {
    offset = statSync(filePath).size;
  } catch {
    // 文件还不存在（全新会话），从 0 开始等它出现。
  }
  let buffer = '';
  let stopped = false;
  let lastDataAt = 0;
  const tick = () => {
    if (stopped) return;
    try {
      const size = statSync(filePath).size;
      if (size > offset) {
        const length = Math.min(size - offset, 1_048_576);
        const fd = openSync(filePath, 'r');
        const chunk = Buffer.alloc(length);
        readSync(fd, chunk, 0, length, offset);
        closeSync(fd);
        offset += length;
        lastDataAt = Date.now();
        buffer += chunk.toString('utf8');
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const rawLine = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!rawLine) continue;
          try {
            processSessionLine(JSON.parse(rawLine) as SessionMessageLine, stats, emit);
          } catch {
            // 网关正在写行的中间状态或旧格式，忽略。
          }
        }
      }
    } catch {
      // 会话文件暂时不可读，下个周期再试。
    }
  };
  const timer = setInterval(tick, SESSION_POLL_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    lastDataAt: () => lastDataAt
  };
}

function composeSummary(stats: RunStats): string {
  const parts: string[] = [];
  const toolNames = Object.keys(stats.toolCounts);
  if (toolNames.length > 0) parts.push(`使用了工具 ${toolNames.join('、')}`);
  if (stats.totalCommands > 0) {
    let commandsPart = `共执行 ${stats.totalCommands} 条命令`;
    if (stats.commands.length > 0) {
      const shown = stats.commands.slice(0, MAX_SUMMARY_COMMAND_EXAMPLES).join('；');
      const more = stats.totalCommands > stats.commands.length ? ' 等' : '';
      commandsPart += `（例如：${shown}${more}）`;
    }
    parts.push(commandsPart);
  }
  if (stats.skills.length > 0) parts.push(`调用了 skill ${stats.skills.join('、')}`);
  return parts.join('；');
}

let activeTaskRun = false;

// 网关可能在 CLI 退出后才把最后的回复事件写进会话文件，所以 close 之后
// 还留一段收尾轮询；新任务启动时停掉它们，避免读到本次任务的事件。
let drainingTails: Array<{ stop: () => void }> = [];

export function runOpenClawTask(task: string, options: RunOpenClawTaskOptions): Promise<OpenClawTaskResult> {
  for (const tail of drainingTails) tail.stop();
  drainingTails = [];
  const bin = resolveOpenClawBin();
  if (!bin) throw new Error('没有检测到 OpenClaw 命令，无法委派任务。');
  if (activeTaskRun) throw new Error('已有一个任务在执行，请等它完成。');
  activeTaskRun = true;

  const { userDataDir, onHeartbeat, onEvent } = options;
  const emit = onEvent ?? (() => {});
  const stats: RunStats = { toolCounts: {}, totalCommands: 0, commands: [], skills: [] };

  const stored = readStoredSession(userDataDir);
  const sessionId = stored?.sessionId ?? randomUUID();
  const sessionFile =
    stored?.sessionFile && existsSync(stored.sessionFile)
      ? stored.sessionFile
      : path.join(sessionsDir(), `${sessionId}.jsonl`);

  const npmGlobalBin = process.platform === 'win32'
    ? path.join(homedir(), 'AppData', 'Roaming', 'npm')
    : path.join(homedir(), '.npm-global', 'bin');
  const extraPath = process.platform === 'win32'
    ? [npmGlobalBin, process.env.PATH]
    : [npmGlobalBin, '/usr/local/bin', process.env.PATH];
  const env = {
    ...process.env,
    PATH: extraPath.filter(Boolean).join(path.delimiter)
  };
  const args = [
    'agent',
    '--agent', 'main',
    '--message', task,
    '--thinking', 'high',
    '--json',
    '--timeout', String(CLI_SOFT_TIMEOUT_SECONDS),
    '--session-id', sessionId
  ];

  const startedAt = Date.now();
  const stdoutChunks: Buffer[] = [];
  let stderrTail = '';

  // Windows cannot exec a .cmd shim directly; route it through a shell
  // (Node's documented way of launching .bat/.cmd files).
  const useCmdWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const child = useCmdWrapper
    ? spawn(bin, args, { env, shell: true })
    : spawn(bin, args, { env });
  const tail = startSessionTail(sessionFile, stats, emit);
  const heartbeat = setInterval(() => {
    onHeartbeat(Math.floor((Date.now() - startedAt) / 1_000));
  }, HEARTBEAT_INTERVAL_MS);
  let hardTimedOut = false;
  const hardTimeout = setTimeout(() => {
    hardTimedOut = true;
    child.kill('SIGTERM');
  }, HARD_TIMEOUT_MS);

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS);
  });

  return new Promise<OpenClawTaskResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(hardTimeout);
      activeTaskRun = false;
      // 网关在 CLI 退出后可能还有尾部事件落盘（实测约 2 秒内），
      // 收尾轮询直到静默或超时，把尾部事件也推给调用方。
      const drainedAt = Date.now() + TAIL_DRAIN_MAX_MS;
      const drainTimer = setInterval(() => {
        const quiet = Date.now() - tail.lastDataAt() >= TAIL_DRAIN_QUIET_MS;
        if (quiet || Date.now() >= drainedAt) {
          clearInterval(drainTimer);
          tail.stop();
          drainingTails = drainingTails.filter((entry) => entry !== tail);
        }
      }, SESSION_POLL_INTERVAL_MS);
      drainingTails.push(tail);
      fn();
    };
    child.on('error', (error) => {
      finish(() => reject(new Error(`无法启动 OpenClaw（${bin}）：${error.message}`)));
    });
    child.on('close', (code) => {
      finish(() => {
        const partialSummary = composeSummary(stats);
        if (hardTimedOut) {
          clearStoredSessionId(userDataDir);
          const detail = partialSummary ? `（已完成部分：${partialSummary}）` : '';
          reject(new Error(`OpenClaw 任务超过 11 分钟硬上限，已终止。${detail}`));
          return;
        }
        if (code !== 0) {
          const detail = stderrTail.trim() || `退出码 ${code}`;
          const progress = partialSummary ? `（已完成部分：${partialSummary}）` : '';
          clearStoredSessionId(userDataDir);
          reject(new Error(`OpenClaw 任务失败：${detail.slice(0, MAX_STDERR_CHARS)}${progress}`));
          return;
        }
        const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
        let parsed: OpenClawResultJson;
        try {
          parsed = JSON.parse(raw) as OpenClawResultJson;
        } catch {
          clearStoredSessionId(userDataDir);
          reject(new Error('OpenClaw 返回了无法解析的结果。'));
          return;
        }
        if (parsed.status !== 'ok') {
          const summary = typeof parsed.summary === 'string' && parsed.summary ? `（${parsed.summary}）` : '';
          clearStoredSessionId(userDataDir);
          reject(new Error(`OpenClaw 任务没有成功完成${summary}`));
          return;
        }
        const agentMeta = parsed.result?.meta?.agentMeta;
        const resultSessionId =
          typeof agentMeta?.sessionId === 'string' && agentMeta.sessionId ? agentMeta.sessionId : sessionId;
        const resultSessionFile =
          typeof agentMeta?.sessionFile === 'string' && agentMeta.sessionFile ? agentMeta.sessionFile : null;
        writeStoredSession(userDataDir, resultSessionId, resultSessionFile);
        const texts = (parsed.result?.payloads ?? [])
          .map((payload) => (typeof payload?.text === 'string' ? payload.text : ''))
          .filter((text) => text.length > 0);
        const reply = texts.join('\n').trim();
        if (!reply) {
          reject(new Error('OpenClaw 任务完成了，但没有返回结果文本。'));
          return;
        }
        const finalReply = reply.length > MAX_REPLY_CHARS
          ? `${reply.slice(0, MAX_REPLY_CHARS)}…（结果过长，已截断）`
          : reply;
        resolve({ reply: finalReply, summary: composeSummary(stats) });
      });
    });
  });
}
