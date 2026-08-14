/**
 * Builder Service
 * ---------------------------------------------------------------
 * Men-generate konfigurasi target (Capacitor / Cordova) dan
 * menjalankan command CLI untuk build APK.
 *
 * Pada production:
 *   - Pakai Capacitor + Android SDK di Docker container
 *   - Atau delegasi ke CI runner (GitHub Actions, Buildkite, dll)
 *
 * Pada tahap ini:
 *   - SIMULASI pakai child_process.exec dengan sleep + echo
 *   - Hasil: APK dummy (file kosong) di BUILD_OUTPUT_DIR/<job_id>.apk
 *   - Logging lengkap ke file log/<job_id>.log
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { AppError } = require('../middlewares/errorHandler');

const execAsync = promisify(exec);

const BUILD_OUTPUT_DIR =
  process.env.BUILD_OUTPUT_DIR || './storage/builds';
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS) || 300000;

// =============================================
// 1. Inject user input ke Capacitor config template
// =============================================
/**
 * Generate file `capacitor.config.json` di working dir project
 * berdasarkan input user.
 *
 * @param {string} projectDir - directory project build
 * @param {object} config - input user (app_name, package_name, dll)
 * @returns {string} path ke file config yang dibuat
 */
function generateCapacitorConfig(projectDir, config) {
  const capacitorConfig = {
    appId: config.package_name || `com.web2appstudio.${slugify(config.app_name)}`,
    appName: config.app_name,
    webDir: 'www',
    bundledWebRuntime: false,
    server: {
      url: config.website_url,
      cleartext: true, // izinkan HTTP untuk simulasi
    },
    android: {
      allowMixedContent: true,
    },
    plugins: {
      SplashScreen: {
        launchShowDuration: 2000,
        backgroundColor: config.primary_color || '#3B82F6',
        showSpinner: true,
      },
      Geolocation: {
        enableHighAccuracy: config.enable_gps || false,
      },
    },
  };

  const configPath = path.join(projectDir, 'capacitor.config.json');
  fs.writeFileSync(configPath, JSON.stringify(capacitorConfig, null, 2), 'utf8');
  return configPath;
}

/**
 * Generate Cordova config.xml (alternatif selain Capacitor)
 */
function generateCordovaConfig(projectDir, config) {
  const packageName =
    config.package_name || `com.web2appstudio.${slugify(config.app_name)}`;

  const xml = `<?xml version='1.0' encoding='utf-8'?>
<widget id="${packageName}" version="1.0.0" xmlns="http://www.w3.org/ns/widgets" xmlns:cdv="http://cordova.apache.org/ns/1.0">
    <name>${escapeXml(config.app_name)}</name>
    <description>Built with Web2App Studio</description>
    <content src="${escapeXml(config.website_url)}" />
    <access origin="*" />
    <preference name="DisallowOverscroll" value="true" />
    <preference name="android-minSdkVersion" value="22" />
    <preference name="BackgroundColor" value="0xff${(config.primary_color || '#3B82F6').replace('#', '')}" />
    ${
      config.enable_gps
        ? '<plugin name="cordova-plugin-geolocation" spec="^5.0.0" />'
        : ''
    }
    ${
      config.enable_push
        ? '<plugin name="cordova-plugin-push" spec="^3.0.0" />'
        : ''
    }
</widget>`;

  const configPath = path.join(projectDir, 'config.xml');
  fs.writeFileSync(configPath, xml, 'utf8');
  return configPath;
}

/**
 * Simpan konfigurasi sebagai JSON untuk arsip/debugging.
 */
function saveConfigManifest(projectDir, config) {
  const manifestPath = path.join(projectDir, 'web2app-manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        ...config,
        generated_at: new Date().toISOString(),
        generator: 'web2app-studio/0.1.0',
      },
      null,
      2
    ),
    'utf8'
  );
  return manifestPath;
}

// =============================================
// 2. Main build process (simulasi CLI Capacitor/Cordova)
// =============================================
/**
 * Jalankan build APK.
 * Pada production: panggil Capacitor CLI `npx cap sync android && cd android && ./gradlew assembleDebug`
 * Pada tahap ini: simulasi dengan sleep + echo.
 *
 * @param {object} params
 * @param {string} params.jobId
 * @param {object} params.config - input user
 * @param {function} params.onLog - callback (chunk) => void untuk streaming log
 * @returns {Promise<{apkPath: string, apkSize: number, logPath: string, durationMs: number}>}
 */
async function runBuild({ jobId, config, onLog }) {
  const startTime = Date.now();
  const projectDir = path.join(BUILD_OUTPUT_DIR, jobId);
  const logPath = path.join(projectDir, 'build.log');
  const apkPath = path.join(projectDir, `${slugify(config.app_name)}.apk`);

  // 1. Setup project directory
  fs.mkdirSync(projectDir, { recursive: true });

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logStream.write(line);
    if (typeof onLog === 'function') onLog(line);
    else process.stdout.write(line);
  };

  try {
    log(`=== Web2App Studio Build Started ===`);
    log(`Job ID: ${jobId}`);
    log(`App Name: ${config.app_name}`);
    log(`Package: ${config.package_name || '(auto)'}`);
    log(`Source URL: ${config.website_url}`);
    log(`Tier Features: GPS=${config.enable_gps}, Push=${config.enable_push}`);
    log('');

    // [Step 1] Generate config files
    log('[1/5] Generating capacitor.config.json...');
    generateCapacitorConfig(projectDir, config);
    log('       ✓ capacitor.config.json written');

    log('[2/5] Generating config.xml (Cordova fallback)...');
    generateCordovaConfig(projectDir, config);
    log('       ✓ config.xml written');

    log('[3/5] Saving manifest...');
    saveConfigManifest(projectDir, config);
    log('       ✓ web2app-manifest.json saved');

    // [Step 2] Fetch website content (simulasi)
    log('[4/5] Fetching website content...');
    await execAsync(
      `echo "[simulated] Would download ${config.website_url} via wget/axios here" && sleep 2`
    );
    log('       ✓ website cached to www/');

    // [Step 3] Run Capacitor CLI (SIMULASI)
    log('[5/5] Running Capacitor CLI (simulated)...');
    log('       $ npx cap add android');
    await execAsync('sleep 1 && echo "       > android platform added"');
    log('       $ npx cap sync android');
    await execAsync('sleep 1 && echo "       > web assets synced"');
    log('       $ cd android && ./gradlew assembleDebug');
    await execAsync('sleep 2 && echo "       > BUILD SUCCESSFUL"');

    // [Step 4] Generate dummy APK file
    log('');
    log('Generating APK artifact...');
    const dummyApkContent = Buffer.from(
      `This is a SIMULATED APK for job ${jobId}.\n` +
        `App: ${config.app_name}\n` +
        `URL: ${config.website_url}\n` +
        `Built at: ${new Date().toISOString()}\n` +
        `In production, this file would be the real signed APK from Gradle.`
    );
    fs.writeFileSync(apkPath, dummyApkContent);
    const apkSize = fs.statSync(apkPath).size;

    const durationMs = Date.now() - startTime;
    log('');
    log(`=== Build SUCCESS in ${durationMs}ms ===`);
    log(`APK: ${apkPath} (${apkSize} bytes)`);

    logStream.end();

    return {
      apkPath,
      apkSize,
      logPath,
      durationMs,
    };
  } catch (err) {
    log(`!!! Build FAILED: ${err.message}`);
    logStream.end();
    throw new AppError(
      `Build process failed: ${err.message}`,
      500,
      'BUILD_EXEC_FAILED'
    );
  }
}

// =============================================
// Helpers
// =============================================
function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'app';
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  runBuild,
  generateCapacitorConfig,
  generateCordovaConfig,
  saveConfigManifest,
  BUILD_OUTPUT_DIR,
};
