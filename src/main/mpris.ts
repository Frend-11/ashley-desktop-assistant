import { execFile } from 'node:child_process';

const mprisPrefix = 'org.mpris.MediaPlayer2.';
const objectPath = '/org/mpris/MediaPlayer2';

export type MusicControlAction = 'play_pause' | 'next' | 'previous';

let lastPlayer: string | null = null;

function gdbusCall(args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/gdbus',
      ['call', '--session', ...args],
      { timeout, maxBuffer: 64_000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(detail || '系统媒体控制失败。'));
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

function extractQuotedStrings(output: string): string[] {
  return [...output.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

export async function listMprisPlayers(): Promise<string[]> {
  try {
    const output = await gdbusCall([
      '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.ListNames'
    ]);
    return extractQuotedStrings(output).filter((name) => name.startsWith(mprisPrefix));
  } catch {
    return [];
  }
}

async function getPlaybackStatus(player: string): Promise<string> {
  try {
    const output = await gdbusCall([
      '--dest', player,
      '--object-path', objectPath,
      '--method', 'org.freedesktop.DBus.Properties.Get',
      'org.mpris.MediaPlayer2.Player', 'PlaybackStatus'
    ]);
    return extractQuotedStrings(output)[0] ?? '';
  } catch {
    return '';
  }
}

export async function controlMprisPlayer(action: MusicControlAction): Promise<string> {
  const players = await listMprisPlayers();
  if (players.length === 0) {
    throw new Error('没有检测到正在运行的媒体播放器。请先打开网易云音乐或任意支持系统媒体控制的播放器。');
  }

  let player = lastPlayer && players.includes(lastPlayer) ? lastPlayer : null;
  if (!player) {
    for (const candidate of players) {
      if (await getPlaybackStatus(candidate) === 'Playing') {
        player = candidate;
        break;
      }
    }
  }
  player ??= players[0];
  lastPlayer = player;

  const method = action === 'next'
    ? 'Next'
    : action === 'previous'
      ? 'Previous'
      : 'PlayPause';
  await gdbusCall([
    '--dest', player,
    '--object-path', objectPath,
    '--method', `org.mpris.MediaPlayer2.Player.${method}`
  ]);

  return action === 'next'
    ? '已切换到下一首。'
    : action === 'previous'
      ? '已切换到上一首。'
      : '已切换播放或暂停。';
}
