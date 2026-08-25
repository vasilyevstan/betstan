#!/usr/bin/env python3

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "infra/oci/scripts/validate-legacy-oci-provenance.py"
SPEC = importlib.util.spec_from_file_location("legacy_oci_provenance", SCRIPT)
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)
SOURCE_SHA = "b78f234f167557121c3562faddc3a096abf5bf18"
BUILD_RUN_ID = "32180000000"
UPSTREAM_RUN_ID = "32170000000"


def write_env(path, values):
    path.write_text(
        "".join(f"{key}={value}\n" for key, value in values.items()),
        encoding="utf-8",
    )


def create_fixture(directory, mode="build"):
    chain = {
        "source_sha": SOURCE_SHA,
        "upstream_workflow": "production-build",
        "upstream_run_id": UPSTREAM_RUN_ID,
        "upstream_run_attempt": "1",
        "build_run_id": BUILD_RUN_ID,
        "build_run_attempt": "1",
        "image_mode": mode,
        "platform": "linux/arm64",
    }
    if mode == "reuse":
        chain["reuse_source_sha"] = "a" * 40
        chain["reuse_build_run_id"] = "32160000000"
    write_env(directory / "build-chain.txt", chain)
    repository = "eu-frankfurt-1.ocir.io/fixture/betstan_images"
    for index, service in enumerate(VALIDATOR.SERVICES, start=1):
        digest = f"sha256:{index:064x}"
        platform_digest = f"sha256:{index + 20:064x}"
        values = {
            "service": service,
            "repository": repository,
            "source_sha": SOURCE_SHA,
            "tag": f"{repository}:oci-{service}-{SOURCE_SHA}",
            "digest": digest,
            "platform_digest": platform_digest,
            "image_ref": f"{repository}@{digest}",
            "platform": "linux/arm64",
            "build_run_id": BUILD_RUN_ID,
            "build_run_attempt": "1",
        }
        if mode == "reuse":
            values["reuse_source_sha"] = chain["reuse_source_sha"]
            values["reuse_build_run_id"] = chain["reuse_build_run_id"]
        write_env(directory / f"{service}.env", values)


class LegacyOciProvenanceTest(unittest.TestCase):
    def test_accepts_exact_historical_build_schema(self):
        with tempfile.TemporaryDirectory() as work:
            directory = Path(work)
            create_fixture(directory)
            self.assertEqual(
                VALIDATOR.validate(directory, SOURCE_SHA, BUILD_RUN_ID),
                UPSTREAM_RUN_ID,
            )

    def test_accepts_exact_historical_reuse_schema(self):
        with tempfile.TemporaryDirectory() as work:
            directory = Path(work)
            create_fixture(directory, mode="reuse")
            self.assertEqual(
                VALIDATOR.validate(directory, SOURCE_SHA, BUILD_RUN_ID),
                UPSTREAM_RUN_ID,
            )

    def test_rejects_fields_not_emitted_by_historical_artifact(self):
        with tempfile.TemporaryDirectory() as work:
            directory = Path(work)
            create_fixture(directory)
            auth = directory / "auth.env"
            with auth.open("a", encoding="utf-8") as stream:
                stream.write("build_workflow=oci-production-build\n")
            with self.assertRaisesRegex(SystemExit, "key set is invalid"):
                VALIDATOR.validate(directory, SOURCE_SHA, BUILD_RUN_ID)

    def test_rejects_manifest_identity_mismatch(self):
        with tempfile.TemporaryDirectory() as work:
            directory = Path(work)
            create_fixture(directory)
            auth = directory / "auth.env"
            text = auth.read_text(encoding="utf-8")
            auth.write_text(
                text.replace("image_ref=", "image_ref=wrong-", 1),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(SystemExit, "provenance is invalid"):
                VALIDATOR.validate(directory, SOURCE_SHA, BUILD_RUN_ID)


if __name__ == "__main__":
    unittest.main()
