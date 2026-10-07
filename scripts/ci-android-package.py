#!/usr/bin/env python3
"""Inspect an existing APK and prepare/verify the prototype distribution bundle.

Uses the official Android Build Tools and Python's standard library. It never
builds, signs, changes a key, or publishes a release.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parents[1]
APK_NAME = "perch-prototype-arm64.apk"
METADATA_NAME = "release-metadata.json"
CHECKSUM_NAME = "SHA256SUMS"
FILES = {APK_NAME, METADATA_NAME, CHECKSUM_NAME}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, stderr=subprocess.STDOUT).strip()


def versions():
    return json.loads(run("node", str(ROOT / "scripts/ci-android-version.mjs"), "--json"))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def only_match(pattern, text, label):
    matches = re.findall(pattern, text, re.MULTILINE)
    require(len(matches) == 1, f"Expected exactly one {label}; found {len(matches)}.")
    return matches[0]


def inspect_elf(data, name):
    require(data[:6] == b"\x7fELF\x02\x01", f"{name} must be a 64-bit little-endian ELF.")
    require(struct.unpack_from("<H", data, 18)[0] == 183, f"{name} must target AArch64.")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phentsize, phnum = struct.unpack_from("<HH", data, 54)
    require(phentsize >= 56 and phoff + phentsize * phnum <= len(data), f"Invalid ELF program headers: {name}.")
    alignments = []
    for index in range(phnum):
        offset = phoff + index * phentsize
        if struct.unpack_from("<I", data, offset)[0] == 1:  # PT_LOAD
            alignment = struct.unpack_from("<Q", data, offset + 48)[0]
            require(alignment >= 16384 and alignment & (alignment - 1) == 0,
                    f"{name} has a LOAD segment below 16 KB alignment.")
            alignments.append(alignment)
    require(alignments, f"No LOAD segments in {name}.")
    return alignments


def inspect_apk(apk, sdk, version):
    build_tools = sdk / "build-tools/36.0.0"
    badging = run(str(build_tools / "aapt2"), "dump", "badging", str(apk))
    package_line = only_match(r"^package: (.+)$", badging, "binary package declaration")
    fields = dict(re.findall(r"\b(\w+)='([^']*)'", package_line))
    require(fields.get("name") == version["packageName"], "APK package does not match the prototype.")
    require(fields.get("versionName") == version["versionName"], "APK versionName is stale or incorrect.")
    require(fields.get("versionCode") == str(version["versionCode"]), "APK versionCode is stale or incorrect.")
    require(fields.get("compileSdkVersion") == "36", "Expected compile SDK 36.")
    minimum = only_match(r"^(?:minSdkVersion|sdkVersion):'(\d+)'$", badging, "minimum SDK")
    target = only_match(r"^targetSdkVersion:'(\d+)'$", badging, "target SDK")
    require((minimum, target) == ("24", "36"), "Expected minimum/target SDK 24/36.")
    require(not re.search(r"^application-debuggable(?:\s|$)", badging, re.MULTILINE), "A debuggable APK cannot be released.")
    native_code = only_match(r"^native-code: (.+)$", badging, "native ABI declaration")
    require(re.findall(r"'([^']+)'", native_code) == ["arm64-v8a"], "APK must contain only the ARM64 ABI.")

    signature = run(str(build_tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk))
    certificates = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)$", signature, re.MULTILINE)
    require([value.lower() for value in certificates] == [version["certificateSha256"]],
            "APK signer drifted from the preserved prototype certificate.")
    require(re.search(r"^Verified using v2 scheme .*: true$", signature, re.MULTILINE), "APK Signature Scheme v2 verification is required.")
    run(str(build_tools / "zipalign"), "-c", "-P", "16", "4", str(apk))

    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "APK contains duplicate ZIP entries.")
        native_libraries = [name for name in names if name.startswith("lib/") and name.endswith(".so")]
        require(native_libraries, "APK contains no native libraries.")
        require(all(re.fullmatch(r"lib/arm64-v8a/[^/]+\.so", name) for name in native_libraries),
                "APK ZIP contains a non-ARM64 or unexpected native library path.")
        elf_alignments = {name: inspect_elf(archive.read(name), name) for name in native_libraries}
        bundle_name = "assets/index.android.bundle"
        require(bundle_name in names, "Standalone APK must embed its application bundle.")
        bundle = archive.read(bundle_name)
        require(bundle, "Embedded application bundle is empty.")
        generated_bundle = ROOT / "android/app/build/generated/assets/react/release/index.android.bundle"
        require(generated_bundle.is_file(), "The generated release bundle is missing.")
        require(sha256(bundle) == file_sha256(generated_bundle), "Embedded bundle differs from this build's generated bundle.")
        notice_name = "assets/third-party-notices.txt"
        require(notice_name in names, "APK must embed third-party license notices.")
        notices = archive.read(notice_name)
        source_notices = ROOT / "android/app/src/main/assets/third-party-notices.txt"
        require(notices and source_notices.is_file(), "Checked-in third-party notices must be present and nonempty.")
        require(sha256(notices) == file_sha256(source_notices), "Embedded notices differ from the checked-in notice asset.")
    return {
        "minSdk": 24, "targetSdk": 36, "compileSdk": 36,
        "abis": ["arm64-v8a"], "debuggable": False,
        "embeddedBundle": {"entry": bundle_name, "bytes": len(bundle), "sha256": sha256(bundle)},
        "thirdPartyNotices": {"entry": notice_name, "bytes": len(notices), "sha256": sha256(notices)},
        "verification": {
            "apkSignatureV2": True, "zipAlignment16KB": True,
            "noDuplicateZipEntries": True, "embeddedBundleMatchesGenerated": True,
            "thirdPartyNoticesMatchSource": True,
            "nativeElfMinimumAlignment": 16384, "nativeLibraryCount": len(native_libraries),
            "nativeElfLoadAlignments": elf_alignments,
        },
    }


def prepare(args):
    version = versions()
    tag = args.tag or None
    require(not tag or tag == f"v{version['versionName']}", "Tag must exactly match the app version.")
    apk = args.apk.resolve()
    require(apk.is_file(), f"APK is missing: {apk}")
    sdk = args.sdk or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    require(sdk, "Set ANDROID_HOME or pass --sdk for the installed official Android SDK.")
    inspected = inspect_apk(apk, Path(sdk), version)
    source_commit = run("git", "rev-parse", "HEAD")
    source_clean = not run("git", "status", "--porcelain", "--untracked-files=no")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        require(source_clean, "Tracked sources changed during the CI build.")
        require(source_commit == os.environ.get("GITHUB_SHA"), "Built checkout differs from the workflow SHA.")
    repository = os.environ.get("GITHUB_REPOSITORY") or None
    server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    run_id = os.environ.get("GITHUB_RUN_ID")
    metadata = {
        "schemaVersion": 1, "channel": "prototype", "prerelease": True, "releaseTag": tag,
        **version,
        "sourceCommit": source_commit, "sourceTreeClean": source_clean, "repository": repository,
        "workflowRunUrl": f"{server_url}/{repository}/actions/runs/{run_id}" if repository and run_id else None,
        "workflowRunAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "apk": {"fileName": APK_NAME, "bytes": apk.stat().st_size, "sha256": file_sha256(apk)},
        "signingIdentity": "public-prototype-development-key",
        "toolchain": {"nodeMajor": 24, "gradleJdkMajor": 21, "pluginJdkMajor": 17,
                      "androidBuildTools": "36.0.0", "ndk": "27.1.12297006", "cmake": "3.22.1"},
        **inspected,
    }
    output = args.output_dir.resolve()
    require(not output.exists() or not any(output.iterdir()), "Output directory must be new or empty; existing releases are never overwritten.")
    output.mkdir(parents=True, exist_ok=True)
    with (output / APK_NAME).open("xb") as destination, apk.open("rb") as source:
        shutil.copyfileobj(source, destination)
    require(file_sha256(output / APK_NAME) == metadata["apk"]["sha256"], "Copied APK checksum changed.")
    with (output / METADATA_NAME).open("x", encoding="utf-8") as destination:
        json.dump(metadata, destination, indent=2)
        destination.write("\n")
    with (output / CHECKSUM_NAME).open("x", encoding="utf-8") as destination:
        for name in (APK_NAME, METADATA_NAME):
            destination.write(f"{file_sha256(output / name)}  {name}\n")
    print(f"Verified {APK_NAME}: {version['versionName']} / code {version['versionCode']}; {metadata['apk']['sha256']}")


def inspect_distribution(directory, version, tag, commit, repository):
    require(set(item.name for item in directory.iterdir()) == FILES, "Distribution must contain exactly the APK, SHA256SUMS, and metadata.")
    require(all((directory / name).is_file() and not (directory / name).is_symlink() for name in FILES), "Distribution assets must be regular files.")
    expected_checksums = "".join(f"{file_sha256(directory / name)}  {name}\n" for name in (APK_NAME, METADATA_NAME))
    require((directory / CHECKSUM_NAME).read_text() == expected_checksums, "Distribution checksum mismatch.")
    metadata = json.loads((directory / METADATA_NAME).read_text())
    for field, expected in version.items():
        require(metadata.get(field) == expected, f"Distribution {field} does not match the checked-out release.")
    for field, expected in {
        "schemaVersion": 1, "channel": "prototype", "prerelease": True,
        "releaseTag": tag, "sourceCommit": commit, "sourceTreeClean": True,
        "repository": repository, "signingIdentity": "public-prototype-development-key",
        "abis": ["arm64-v8a"], "debuggable": False, "minSdk": 24, "targetSdk": 36, "compileSdk": 36,
    }.items():
        require(metadata.get(field) == expected, f"Distribution {field} is incorrect.")
    require(tag == f"v{version['versionName']}", "Release tag does not match the app.")
    require(metadata.get("apk") == {"fileName": APK_NAME, "bytes": (directory / APK_NAME).stat().st_size,
                                    "sha256": file_sha256(directory / APK_NAME)}, "APK metadata does not match the asset.")
    for field in ("apkSignatureV2", "zipAlignment16KB", "noDuplicateZipEntries", "embeddedBundleMatchesGenerated", "thirdPartyNoticesMatchSource"):
        require(metadata.get("verification", {}).get(field) is True, f"Missing APK verification gate: {field}.")
    require(metadata.get("verification", {}).get("nativeElfMinimumAlignment") == 16384, "Missing native ELF alignment check.")
    return metadata


def verify_bundle(args):
    version = versions()
    commit = run("git", "rev-parse", "HEAD")
    require(os.environ.get("GITHUB_SHA") == commit, "Release checkout must match the workflow SHA.")
    repository = os.environ.get("GITHUB_REPOSITORY")
    require(repository and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "A GitHub repository is required.")
    metadata = inspect_distribution(args.directory.resolve(), version, args.tag, commit, repository)
    if args.notes:
        server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
        args.notes.write_text(
            f"# Perch {args.tag} prototype\n\n"
            "Standalone Android ARM64 prototype with its application bundle embedded.\n\n"
            f"- Package: `{metadata['packageName']}`\n"
            f"- Version: `{metadata['versionName']}`; Android version code: `{metadata['versionCode']}`\n"
            f"- Source: [{commit}]({server_url}/{repository}/tree/{commit})\n"
            f"- APK SHA-256: `{metadata['apk']['sha256']}`\n"
            f"- Signer SHA-256: `{metadata['certificateSha256']}`\n\n"
            "This prerelease preserves the existing public prototype signing key for compatible prototype updates. "
            "It is not a private production identity. Production distribution requires a private permanent key and a planned migration.\n\n"
            f"In Obtainium, add `{server_url}/{repository}`, allow prereleases, and set the APK filename filter to "
            "`^perch-prototype-arm64\\.apk$`. Leave **Verify Latest Tag** disabled for this prerelease channel.\n\n"
            "CI checked app/protocol/backend behavior, the final binary identity, ARM64 ABI, embedded bundle, signer, and 16 KB alignment. "
            "Native startup, installation/upgrade behavior, and live-host flows require device verification.\n\n"
            "`SHA256SUMS` covers the APK and `release-metadata.json`.\n",
            encoding="utf-8",
        )
    print(f"Verified distribution for {args.tag} at {commit}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    package = commands.add_parser("package", help="Inspect the already-built APK and copy release assets")
    package.add_argument("--apk", type=Path, default=ROOT / "android/app/build/outputs/apk/release/app-release.apk")
    package.add_argument("--sdk", type=Path)
    package.add_argument("--output-dir", type=Path, required=True)
    package.add_argument("--tag", default="")
    package.set_defaults(operation=prepare)
    verify = commands.add_parser("verify-bundle", help="Verify downloaded assets before GitHub publication")
    verify.add_argument("--directory", type=Path, required=True)
    verify.add_argument("--tag", required=True)
    verify.add_argument("--notes", type=Path)
    verify.set_defaults(operation=verify_bundle)
    args = parser.parse_args()
    args.operation(args)


if __name__ == "__main__":
    main()
