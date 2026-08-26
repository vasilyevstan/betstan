#!/usr/bin/env python3

import hashlib
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "infra/oci/scripts/push-oci-archive-to-ghcr.py"
SPEC = importlib.util.spec_from_file_location("oci_archive_publisher", SCRIPT)
PUBLISHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLISHER)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(data):
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def add_file(archive, name, data):
    member = tarfile.TarInfo(name)
    member.mode = 0o644
    member.size = len(data)
    archive.addfile(member, io.BytesIO(data))


def write_archive(path, architecture="arm64", corrupt_layer=False, unsafe=False):
    config = encoded(
        {
            "architecture": architecture,
            "os": "linux",
            "config": {},
            "rootfs": {"type": "layers", "diff_ids": []},
        }
    )
    layer = b"exact-compressed-layer-bytes"
    config_digest = digest(config)
    layer_digest = digest(layer)
    manifest = encoded(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": config_digest,
                "size": len(config),
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": layer_digest,
                    "size": len(layer),
                }
            ],
        }
    )
    manifest_digest = digest(manifest)
    index = encoded(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": manifest_digest,
                    "size": len(manifest),
                    "platform": {"os": "linux", "architecture": architecture},
                }
            ],
        }
    )
    with tarfile.open(path, "w") as archive:
        add_file(archive, "oci-layout", encoded({"imageLayoutVersion": "1.0.0"}))
        add_file(archive, "index.json", index)
        add_file(archive, f"blobs/sha256/{config_digest[7:]}", config)
        add_file(
            archive,
            f"blobs/sha256/{layer_digest[7:]}",
            b"changed" if corrupt_layer else layer,
        )
        add_file(archive, f"blobs/sha256/{manifest_digest[7:]}", manifest)
        if unsafe:
            add_file(archive, "../outside", b"unsafe")
    return {
        "config": (config_digest, config),
        "layer": (layer_digest, layer),
        "manifest": (manifest_digest, manifest),
    }


class ArchivePublisherTest(unittest.TestCase):
    def run_main(self, archive, expected):
        uploaded = []
        published = []
        environment = {
            "OCI_ARCHIVE_FILE": str(archive),
            "GHCR_TARGET_TAG": "arm64-auth-" + "1" * 40,
            "EXPECTED_PLATFORM_DIGEST": expected["manifest"][0],
            "GHCR_ACTOR": "fixture-actor",
            "GHCR_TOKEN": "fixture-token",
        }
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(
            PUBLISHER, "obtain_bearer_token", return_value="bearer"
        ), mock.patch.object(
            PUBLISHER,
            "upload_blob",
            side_effect=lambda blob_digest, data, bearer: uploaded.append(
                (blob_digest, data, bearer)
            ),
        ), mock.patch.object(
            PUBLISHER,
            "publish_manifest",
            side_effect=lambda tag, manifest_digest, media_type, data, bearer: published.append(
                (tag, manifest_digest, media_type, data, bearer)
            ),
        ):
            PUBLISHER.main()
        return uploaded, published

    def test_uploads_exact_manifest_config_and_layer_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "image.tar"
            expected = write_archive(archive)
            uploaded, published = self.run_main(archive, expected)
        self.assertEqual(
            uploaded,
            [
                (*expected["config"], "bearer"),
                (*expected["layer"], "bearer"),
            ],
        )
        self.assertEqual(published[0][1], expected["manifest"][0])
        self.assertEqual(published[0][3], expected["manifest"][1])
        self.assertEqual(published[0][4], "bearer")

    def test_rejects_corrupt_blob_before_network_access(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "corrupt.tar"
            expected = write_archive(archive, corrupt_layer=True)
            with self.assertRaisesRegex(SystemExit, "digest does not match"):
                self.run_main(archive, expected)

    def test_rejects_non_arm64_config(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "amd64.tar"
            expected = write_archive(archive, architecture="amd64")
            with self.assertRaisesRegex(SystemExit, "not linux/arm64"):
                self.run_main(archive, expected)

    def test_rejects_unsafe_archive_member(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "unsafe.tar"
            expected = write_archive(archive, unsafe=True)
            with self.assertRaisesRegex(SystemExit, "unsafe member path"):
                self.run_main(archive, expected)

    def test_rejects_upload_location_outside_target_repository(self):
        with self.assertRaisesRegex(SystemExit, "outside the target repository"):
            PUBLISHER.validate_upload_location(
                "https://ghcr.io/v2/vasilyevstan/other/blobs/upload/"
                "7d8507d3-d549-4fad-9113-aaea462eeb23"
            )

    def test_accepts_ghcr_singular_upload_location(self):
        location = (
            "/v2/vasilyevstan/betstan-images/blobs/upload/"
            "7d8507d3-d549-4fad-9113-aaea462eeb23"
        )
        self.assertEqual(
            PUBLISHER.validate_upload_location(location),
            f"https://ghcr.io{location}",
        )

    def test_accepts_repository_bound_plural_upload_location(self):
        location = (
            "https://ghcr.io/v2/vasilyevstan/betstan-images/blobs/uploads/"
            "7d8507d3-d549-4fad-9113-aaea462eeb23?_state=fixture"
        )
        self.assertEqual(PUBLISHER.validate_upload_location(location), location)

    def test_rejects_non_uuid_upload_location(self):
        with self.assertRaisesRegex(SystemExit, "outside the target repository"):
            PUBLISHER.validate_upload_location(
                "/v2/vasilyevstan/betstan-images/blobs/upload/not-an-upload-id"
            )

    def test_rejects_upload_location_with_digest(self):
        with self.assertRaisesRegex(SystemExit, "already contains a digest"):
            PUBLISHER.validate_upload_location(
                "/v2/vasilyevstan/betstan-images/blobs/upload/"
                "7d8507d3-d549-4fad-9113-aaea462eeb23?digest=untrusted"
            )


if __name__ == "__main__":
    unittest.main()
