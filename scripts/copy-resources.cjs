const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');

const nativeDestination = path.join(distRoot, 'native');
fs.rmSync(nativeDestination, { recursive: true, force: true });
fs.mkdirSync(nativeDestination, { recursive: true });

// Windows 桥接脚本(PowerShell 5.1,系统自带)无条件拷贝:Windows 包可能在
// 任何宿主机上交叉构建,bridge 运行时才读这些文件。
for (const script of ['windows-shell.ps1', 'music-automation.ps1', 'play-sound.ps1']) {
  fs.copyFileSync(
    path.join(projectRoot, 'src', 'native', script),
    path.join(nativeDestination, script)
  );
}

if (process.platform === 'darwin') {
  execFileSync('/usr/bin/swiftc', [
    '-O',
    path.join(projectRoot, 'src', 'native', 'window-status.swift'),
    '-o',
    path.join(nativeDestination, 'window-status')
  ]);

  // macOS grants location permission per app bundle, so the coarse location
  // helper must be a real .app with its own
  // Info.plist rather than a bare binary.
  const locationAppRoot = path.join(nativeDestination, 'JarvisLocation.app', 'Contents');
  const locationExecutableRoot = path.join(locationAppRoot, 'MacOS');
  fs.mkdirSync(locationExecutableRoot, { recursive: true });
  execFileSync('/usr/bin/swiftc', [
    '-O',
    path.join(projectRoot, 'src', 'native', 'location.swift'),
    '-framework',
    'CoreLocation',
    '-o',
    path.join(locationExecutableRoot, 'JarvisLocation')
  ]);
  fs.copyFileSync(
    path.join(projectRoot, 'src', 'native', 'location-helper-info.plist'),
    path.join(locationAppRoot, 'Info.plist')
  );
}

for (const directory of ['renderer', 'assets']) {
  const source = path.join(projectRoot, directory === 'renderer' ? 'src' : '', directory);
  const destination = path.join(distRoot, directory);

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      if (directory === 'renderer') return !entry.endsWith('.ts');
      return path.basename(entry) !== 'model.original.glb';
    }
  });
}

// macOS 的 template 托盘图是单色黑，在 GNOME 的深色顶栏上看不见。
// Linux 构建时反白一份，主进程按平台选用。
if (process.platform === 'linux') {
  const sharp = require('sharp');
  sharp(path.join(projectRoot, 'assets', 'tray', 'iconTemplate@2x.png'))
    .negate()
    .resize(64, 64)
    .png()
    .toFile(path.join(distRoot, 'assets', 'tray', 'icon-linux.png'))
    .catch((error) => {
      console.error('Unable to generate the Linux tray icon.', error);
      process.exitCode = 1;
    });
}

// Windows 任务栏深浅色都常见，把单色剪影重着色成琥珀色。这里无条件生成:
// Windows 安装包可能在 Linux/macOS 宿主机上交叉构建，构建时的 process.platform
// 是宿主机平台，不是目标平台。
async function generateWindowsTrayIcons() {
  const sharp = require('sharp');
  const source = path.join(projectRoot, 'assets', 'tray', 'iconTemplate@2x.png');
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += info.channels) {
    if (data[index + 3] > 0) {
      data[index] = 0xE8;
      data[index + 1] = 0xA3;
      data[index + 2] = 0x3D;
    }
  }
  const colored = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
  await colored
    .clone()
    .resize(32, 32)
    .png()
    .toFile(path.join(distRoot, 'assets', 'tray', 'icon-windows.png'));
  // electron-builder 的 Windows 图标要求 ≥256×256;源图只有 36px,放大偏软,
  // 功能可用,有正式图标后替换 assets/tray 源图即可。
  await colored
    .clone()
    .resize(256, 256, { kernel: 'lanczos3' })
    .png()
    .toFile(path.join(distRoot, 'assets', 'tray', 'icon-windows-256.png'));
}

generateWindowsTrayIcons().catch((error) => {
  console.error('Unable to generate the Windows tray icons.', error);
  process.exitCode = 1;
});

fs.cpSync(
  path.join(projectRoot, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco'),
  path.join(distRoot, 'renderer', 'draco'),
  { recursive: true }
);

const wakePackageRoot = path.dirname(require.resolve('openwakeword-wasm-browser/package.json'));
const wakeDestination = path.join(distRoot, 'assets', 'wake-word');
const wakeModelDestination = path.join(wakeDestination, 'models');
fs.mkdirSync(wakeModelDestination, { recursive: true });
for (const file of [
  'melspectrogram.onnx',
  'embedding_model.onnx',
  'silero_vad.onnx',
  'hey_jarvis_v0.1.onnx'
]) {
  fs.copyFileSync(path.join(wakePackageRoot, 'models', file), path.join(wakeModelDestination, file));
}

const ortEntry = require.resolve('onnxruntime-web', { paths: [wakePackageRoot] });
const ortDestination = path.join(wakeDestination, 'ort');
fs.mkdirSync(ortDestination, { recursive: true });
for (const file of [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.wasm'
]) {
  fs.copyFileSync(path.join(path.dirname(ortEntry), file), path.join(ortDestination, file));
}
