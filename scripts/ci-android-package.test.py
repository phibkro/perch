#!/usr/bin/env python3
"""Distribution handoff guards, without Android builds or real credentials."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("perch_apk", Path(__file__).with_name("ci-android-package.py"))
apk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apk)


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="perch-distribution-guard-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.version = apk.versions()
        self.tag = f"v{self.version['versionName']}"
        self.commit = "a" * 40
        self.repository = "example/perch"
        (self.directory / apk.APK_NAME).write_bytes(b"fixture asset; actual APK inspection is a separate build gate")
        self.metadata = {
            **self.version,
            "schemaVersion": 1, "channel": "prototype", "prerelease": True, "releaseTag": self.tag,
            "sourceCommit": self.commit, "sourceTreeClean": True, "repository": self.repository,
            "signingIdentity": "public-prototype-development-key", "abis": ["arm64-v8a"],
            "debuggable": False, "minSdk": 24, "targetSdk": 36, "compileSdk": 36,
            "apk": {"fileName": apk.APK_NAME, "bytes": (self.directory / apk.APK_NAME).stat().st_size,
                    "sha256": apk.file_sha256(self.directory / apk.APK_NAME)},
            "verification": {"apkSignatureV2": True, "zipAlignment16KB": True, "noDuplicateZipEntries": True,
                             "embeddedBundleMatchesGenerated": True, "nativeElfMinimumAlignment": 16384,
                             "thirdPartyNoticesMatchSource": True},
        }
        self.write_metadata_and_checksums()

    def write_metadata_and_checksums(self):
        (self.directory / apk.METADATA_NAME).write_text(json.dumps(self.metadata) + "\n")
        (self.directory / apk.CHECKSUM_NAME).write_text("".join(
            f"{apk.file_sha256(self.directory / name)}  {name}\n" for name in (apk.APK_NAME, apk.METADATA_NAME)))

    def verify(self):
        return apk.inspect_distribution(self.directory, self.version, self.tag, self.commit, self.repository)

    def test_expected_distribution_is_accepted(self):
        self.assertEqual(self.verify()["releaseTag"], self.tag)

    def test_changed_apk_bytes_are_rejected(self):
        (self.directory / apk.APK_NAME).write_bytes(b"modified after upload")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.verify()

    def test_metadata_for_another_commit_is_rejected_even_with_valid_checksums(self):
        self.metadata["sourceCommit"] = "b" * 40
        self.write_metadata_and_checksums()
        with self.assertRaisesRegex(ValueError, "sourceCommit"):
            self.verify()

    def test_second_apk_is_rejected(self):
        (self.directory / "perch-development-arm64.apk").write_bytes(b"wrong variant")
        with self.assertRaisesRegex(ValueError, "exactly"):
            self.verify()

    def test_signer_drift_is_rejected_even_with_valid_checksums(self):
        self.metadata["certificateSha256"] = "b" * 64
        self.write_metadata_and_checksums()
        with self.assertRaisesRegex(ValueError, "certificateSha256"):
            self.verify()

    def test_missing_signature_gate_is_rejected(self):
        self.metadata["verification"]["apkSignatureV2"] = False
        self.write_metadata_and_checksums()
        with self.assertRaisesRegex(ValueError, "apkSignatureV2"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
