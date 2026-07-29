#!/usr/bin/env node
'use strict';
// Idempotently patch the Capacitor-generated android/ project with the native assist layer:
// copy the Java + res/xml sources, add permissions + the assist services to the manifest.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'android', 'app', 'src', 'main');
if (!fs.existsSync(APP)) { console.error('android/ not found — run `npx cap add android` first.'); process.exit(1); }

const javaDst = path.join(APP, 'java', 'com', 'asmltr', 'assistant');
fs.mkdirSync(javaDst, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'native', 'java'))) {
  fs.copyFileSync(path.join(ROOT, 'native', 'java', f), path.join(javaDst, f));
}
const xmlDst = path.join(APP, 'res', 'xml');
fs.mkdirSync(xmlDst, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'native', 'res', 'xml'))) {
  fs.copyFileSync(path.join(ROOT, 'native', 'res', 'xml', f), path.join(xmlDst, f));
}

const mf = path.join(APP, 'AndroidManifest.xml');
let x = fs.readFileSync(mf, 'utf8');
const perms = ['android.permission.RECORD_AUDIO', 'android.permission.INTERNET', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.REQUEST_INSTALL_PACKAGES',
  // persistent floating overlay (survives swipe-home) + its foreground service
  'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE'];
let permXml = perms.filter((p) => !x.includes(p)).map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
if (permXml) x = x.replace(/<application/, permXml + '\n\n    <application');

// Package visibility (Android 11+/API 30): without this, queryIntentActivities only returns a few
// always-visible apps — so "launch facebook" can't see facebook. Declaring the MAIN/LAUNCHER + web-VIEW
// intents makes every launchable app (and browsers) visible to the device-control tools.
const queries = `
    <queries>
        <intent>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
        </intent>
    </queries>
`;
if (!x.includes('<queries>')) x = x.replace(/<application/, queries + '\n    <application');

const services = `
        <service android:name=".AsmltrVoiceInteractionService"
            android:permission="android.permission.BIND_VOICE_INTERACTION" android:exported="true">
            <intent-filter><action android:name="android.service.voice.VoiceInteractionService" /></intent-filter>
            <meta-data android:name="android.voice_interaction" android:resource="@xml/interaction_service" />
        </service>
        <service android:name=".AsmltrSessionService"
            android:permission="android.permission.BIND_VOICE_INTERACTION" android:exported="true" />
        <service android:name=".AsmltrRecognitionService"
            android:permission="android.permission.BIND_VOICE_RECOGNITION" android:exported="true">
            <intent-filter><action android:name="android.speech.RecognitionService" /></intent-filter>
            <meta-data android:name="android.speech" android:resource="@xml/recognition_service" />
        </service>
`;
if (!x.includes('AsmltrVoiceInteractionService')) x = x.replace(/<\/application>/, services + '    </application>');

// FileProvider for the auto-update installer — separate guard (independent of the assist services, so
// it still applies when android/ already has them from a prior build).
const provider = `
        <provider android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.updateprovider" android:exported="false" android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />
        </provider>
`;
if (!x.includes('updateprovider')) x = x.replace(/<\/application>/, provider + '    </application>');
// PackageInstaller session status receiver (launches the system install-confirm dialog).
const receiver = '\n        <receiver android:name=".InstallReceiver" android:exported="false" />\n';
if (!x.includes('InstallReceiver')) x = x.replace(/<\/application>/, receiver + '    </application>');

// The persistent-overlay foreground service (draws the assistant over other apps, survives swipe-home).
const overlaySvc = `
        <service android:name=".OverlayService"
            android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="assistant_overlay" />
        </service>
`;
if (!x.includes('.OverlayService')) x = x.replace(/<\/application>/, overlaySvc + '    </application>');
fs.writeFileSync(mf, x);

// --- versioning (drives auto-update): versionName from package.json, versionCode = M*10000+m*100+p ---
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const vName = pkg.version || '0.0.0';
const mm = vName.split('.').map((n) => parseInt(n, 10) || 0);
const vCode = mm[0] * 10000 + mm[1] * 100 + (mm[2] || 0);
const gradle = path.join(ROOT, 'android', 'app', 'build.gradle');
let g = fs.readFileSync(gradle, 'utf8');
g = g.replace(/versionCode\s+\d+/, 'versionCode ' + vCode).replace(/versionName\s+"[^"]*"/, 'versionName "' + vName + '"');
// androidx.webkit for WebView WebAuthn (passkeys inside the app).
if (!g.includes('androidx.webkit:webkit')) g = g.replace(/dependencies\s*\{/, 'dependencies {\n    implementation "androidx.webkit:webkit:1.12.1"');
fs.writeFileSync(gradle, g);
// Sidecar the connector's /gw/app reads to report the served version.
fs.writeFileSync(path.join(ROOT, 'app-version.json'), JSON.stringify({ versionCode: vCode, versionName: vName }) + '\n');
console.log('patched: java, res/xml, permissions, assist services + version', vName, '(' + vCode + ') →', mf);
