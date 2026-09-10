#!/usr/bin/env python3
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from image_provenance_stan import (
    EXPECTED_REPOSITORIES,
    ProvenanceError,
    TELEMETRY_ERA_AZURE_DIAGNOSTIC,
    reject_telemetry_era_source,
    validate_records,
)


IMAGE_SHA = "a" * 40
BUILD_RUN_ID = "123456"
BUILD_RUN_ATTEMPT = "1"


class ImageProvenanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp_directory.name)
        for index, (service, repository) in enumerate(
            EXPECTED_REPOSITORIES.items(), 1
        ):
            digest = f"sha256:{index:064x}"
            image_ref = f"{repository}:{IMAGE_SHA}@{digest}"
            (self.directory / f"{service}.env").write_text(
                "\n".join(
                    [
                        f"service={service}",
                        f"repository={repository}",
                        f"image_sha={IMAGE_SHA}",
                        f"digest={digest}",
                        f"image_ref={image_ref}",
                        f"build_run_id={BUILD_RUN_ID}",
                        f"build_run_attempt={BUILD_RUN_ATTEMPT}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def test_accepts_complete_exact_build_provenance(self) -> None:
        rows = validate_records(
            self.directory, IMAGE_SHA, BUILD_RUN_ID, BUILD_RUN_ATTEMPT
        )

        self.assertEqual(list(EXPECTED_REPOSITORIES), [row[0] for row in rows])

    def test_rejects_a_missing_service(self) -> None:
        (self.directory / "auth.env").unlink()

        with self.assertRaises(ProvenanceError):
            validate_records(
                self.directory, IMAGE_SHA, BUILD_RUN_ID, BUILD_RUN_ATTEMPT
            )

    def test_rejects_a_mutated_image_reference(self) -> None:
        auth_path = self.directory / "auth.env"
        auth_path.write_text(
            auth_path.read_text(encoding="utf-8").replace(
                "image_ref=stanvasilyev/gaming_auth:",
                "image_ref=attacker.example/gaming_auth:",
            ),
            encoding="utf-8",
        )

        with self.assertRaises(ProvenanceError):
            validate_records(
                self.directory, IMAGE_SHA, BUILD_RUN_ID, BUILD_RUN_ATTEMPT
            )

    def test_rejects_a_rerun(self) -> None:
        with self.assertRaises(ProvenanceError):
            validate_records(self.directory, IMAGE_SHA, BUILD_RUN_ID, "2")

    def test_allows_a_pre_telemetry_source(self) -> None:
        source_root = self.directory / "source"
        source_root.mkdir()

        reject_telemetry_era_source(source_root)

    def test_rejects_a_telemetry_era_source_with_fixed_diagnostic(self) -> None:
        source_root = self.directory / "source"
        (source_root / "telemetry").mkdir(parents=True)
        (source_root / "telemetry" / "package.json").write_text(
            "{}\n", encoding="utf-8"
        )

        with self.assertRaisesRegex(
            ProvenanceError, f"^{re.escape(TELEMETRY_ERA_AZURE_DIAGNOSTIC)}$"
        ):
            reject_telemetry_era_source(source_root)

    def test_cli_rejects_telemetry_before_writing_output(self) -> None:
        source_root = self.directory / "source"
        (source_root / "telemetry").mkdir(parents=True)
        (source_root / "telemetry" / "package.json").write_text(
            "{}\n", encoding="utf-8"
        )
        output = source_root / "provenance.tsv"

        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("image_provenance_stan.py")),
                "--directory",
                str(self.directory),
                "--image-sha",
                IMAGE_SHA,
                "--build-run-id",
                BUILD_RUN_ID,
                "--build-run-attempt",
                BUILD_RUN_ATTEMPT,
                "--output",
                str(output),
            ],
            cwd=source_root,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, f"{TELEMETRY_ERA_AZURE_DIAGNOSTIC}\n")
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
