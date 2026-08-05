#!/usr/bin/env bash
# Package a release APK: 16 KB-align the native libs, then sign.
#
# Order matters. zipalign rewrites entry offsets, so it MUST run before apksigner — aligning a
# signed APK invalidates the v2/v3 signatures.
#
# Why -P 16: Android 15+ devices can boot with 16 KB memory pages. Native libs are packaged
# uncompressed (useLegacyPackaging false) so the loader maps them straight out of the APK, which
# only works if each .so starts on a 16 KB boundary. AGP only does this itself from 8.5.1; this
# project is on 8.2.1, so we align explicitly here.
#
# Signing identity: pass the SAME keystore used by previous releases. An update signed with a
# different key cannot install over an existing one — the user would have to uninstall first,
# losing all app data. There is no recovery from that after the fact.
#
# Usage:
#   ASMLTR_ANDROID_KEYSTORE=/path/to/ks \
#   ASMLTR_ANDROID_KEYSTORE_PASSWORD=... \
#   ASMLTR_ANDROID_KEY_ALIAS=... \
#   ./scripts/package-apk.sh <unsigned.apk> <output.apk>
set -euo pipefail

IN="${1:?usage: package-apk.sh <unsigned.apk> <output.apk>}"
OUT="${2:?usage: package-apk.sh <unsigned.apk> <output.apk>}"

KS="${ASMLTR_ANDROID_KEYSTORE:?set ASMLTR_ANDROID_KEYSTORE}"
KS_PASS="${ASMLTR_ANDROID_KEYSTORE_PASSWORD:-android}"
KS_ALIAS="${ASMLTR_ANDROID_KEY_ALIAS:-androiddebugkey}"
KEY_PASS="${ASMLTR_ANDROID_KEY_PASSWORD:-$KS_PASS}"

command -v zipalign  >/dev/null || { echo "zipalign not on PATH (add \$ANDROID_HOME/build-tools/<ver>)" >&2; exit 1; }
command -v apksigner >/dev/null || { echo "apksigner not on PATH" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

echo "==> zipalign -P 16 (align uncompressed .so to the 16 KB page boundary)"
zipalign -P 16 -f 4 "$IN" "$tmp/aligned.apk"

echo "==> verifying alignment before signing"
zipalign -c -P 16 -v 4 "$tmp/aligned.apk" >/dev/null

echo "==> apksigner sign"
apksigner sign \
  --ks "$KS" --ks-pass "pass:$KS_PASS" \
  --ks-key-alias "$KS_ALIAS" --key-pass "pass:$KEY_PASS" \
  --out "$OUT" "$tmp/aligned.apk"

echo "==> verifying signature"
apksigner verify --print-certs "$OUT" | sed -n '1,4p'

echo "==> native lib alignment in the finished APK"
python3 - "$OUT" <<'PY'
import sys, struct, zipfile
# The file DATA offset is what must land on the page boundary, not the local header offset.
# Read the LOCAL header for each entry: ZipInfo.extra is the CENTRAL directory extra field,
# which zipalign does NOT pad, so computing the offset from it silently reports false failures.
bad = 0
path = sys.argv[1]
with zipfile.ZipFile(path) as z, open(path, 'rb') as f:
    for i in z.infolist():
        if not i.filename.endswith('.so'):
            continue
        f.seek(i.header_offset)
        fn_len, ex_len = struct.unpack('<HH', f.read(30)[26:30])
        data    = i.header_offset + 30 + fn_len + ex_len
        stored  = i.compress_type == 0
        aligned = data % 16384 == 0
        ok = stored and aligned
        bad += 0 if ok else 1
        print("    %-44s %-9s data_off=%-10d 16KB-aligned=%s %s" % (
            i.filename, 'STORED' if stored else 'DEFLATED', data, aligned, '' if ok else '  <-- FAIL'))
raise SystemExit(1 if bad else 0)
PY

echo "==> OK: $OUT"
