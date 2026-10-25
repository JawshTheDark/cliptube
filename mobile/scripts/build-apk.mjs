// Builds a release APK into mobile/dist/.
//
//   npm run build:apk
//
// Signing: set CLIPTUBE_KEYSTORE, CLIPTUBE_KEYSTORE_PASSWORD (and optionally CLIPTUBE_KEY_ALIAS), or keep them
// in ~/.cliptube/android-release.properties (KEY=value lines). Without a key the APK is debug-signed, which
// installs fine but can't update an APK signed with the real key.
// Needs the Android SDK (ANDROID_HOME, or Android Studio's default location) and JDK 17 or newer
// (JAVA_HOME, or Android Studio's bundled JDK). Windows path limits for the native parts are handled by
// plugins/withShortNativePaths.js.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const env = { ...process.env, CI: '1' };

// ---- signing ----
const props = process.env.CLIPTUBE_SIGNING_PROPS || path.join(os.homedir(), '.cliptube', 'android-release.properties');
if (!env.CLIPTUBE_KEYSTORE && fs.existsSync(props)) {
  for (const line of fs.readFileSync(props, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
}
if (env.CLIPTUBE_KEYSTORE && !fs.existsSync(env.CLIPTUBE_KEYSTORE)) throw new Error(`Keystore not found: ${env.CLIPTUBE_KEYSTORE}`);
console.log(env.CLIPTUBE_KEYSTORE ? `Signing with ${env.CLIPTUBE_KEYSTORE}` : 'No upload key set: the APK will be debug-signed');

// ---- toolchain ----
const javaMajor = (home) => {
  try {
    const m = /JAVA_VERSION="(\d+)(?:\.(\d+))?/.exec(fs.readFileSync(path.join(home, 'release'), 'utf8'));
    return m ? (m[1] === '1' ? Number(m[2]) : Number(m[1])) : 0;
  } catch {
    return 0;
  }
};
if (!env.JAVA_HOME || javaMajor(env.JAVA_HOME) < 17) {
  const candidates = win
    ? ['C:\\Program Files\\Android\\Android Studio\\jbr']
    : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr')];
  const jbr = candidates.find((c) => javaMajor(c) >= 17);
  if (!jbr) throw new Error('JDK 17 or newer is needed: set JAVA_HOME (Android Studio ships one in its jbr folder)');
  env.JAVA_HOME = jbr;
}
if (!env.ANDROID_HOME) {
  const sdk = win ? path.join(env.LOCALAPPDATA || '', 'Android', 'Sdk') : path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
  if (!fs.existsSync(sdk)) throw new Error('Android SDK not found: set ANDROID_HOME');
  env.ANDROID_HOME = sdk;
}
console.log(`JDK: ${env.JAVA_HOME} (Java ${javaMajor(env.JAVA_HOME)})\nSDK: ${env.ANDROID_HOME}`);

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit', shell: win });

/**
 * Windows limits paths to 260 characters, and the native (CMake) builds nest full source paths inside their
 * build folders. Even with CMake shortening object names (plugins/withShortNativePaths.js) a project at
 * C:\Users\<name>\Personal-Videos\mobile leaves too little room, so on Windows the build runs in a mirror at a
 * short path (C:\Users\<name>\.ctb, or CLIPTUBE_BUILD_DIR), kept in sync with robocopy. CLIPTUBE_IN_PLACE=1
 * builds here instead.
 */
function buildDir() {
  if (!win || env.CLIPTUBE_IN_PLACE) return root;
  const dir = env.CLIPTUBE_BUILD_DIR || path.join(os.homedir(), '.ctb');
  if (dir.length >= root.length) return root;
  console.log(`Mirroring to ${dir} to keep native build paths under Windows' limit`);
  const skip = ['android', 'dist', '.expo'].map((d) => path.join(root, d));
  const r = spawnSync('robocopy', [root, dir, '/MIR', '/XD', ...skip, '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], { stdio: 'inherit' });
  if (r.status === null || r.status >= 8) throw new Error(`robocopy failed (exit ${r.status})`);
  return dir;
}

// ---- build ----
const where = buildDir();
run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install'], where);
// Modern phones (64-bit and older 32-bit ARM) and the x86_64 emulator.
const archs = env.CLIPTUBE_ARCHS || 'arm64-v8a,armeabi-v7a,x86_64';
run(path.join(where, 'android', win ? 'gradlew.bat' : 'gradlew'), ['assembleRelease', `-PreactNativeArchitectures=${archs}`, '--no-daemon'], path.join(where, 'android'));

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const out = path.join(root, 'dist', `cliptube-${version}.apk`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(path.join(where, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'), out);
console.log(`\nAPK: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
