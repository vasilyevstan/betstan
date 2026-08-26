#!/usr/bin/env python3

import base64
import hashlib
import json
import os
import re
import ssl
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath


REGISTRY = "ghcr.io"
REPOSITORY = "vasilyevstan/betstan-images"
MANIFEST_MEDIA_TYPES = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}
INDEX_MEDIA_TYPES = {
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
}
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}")
TAG_RE = re.compile(
    r"arm64-(auth|bet|backoffice|client|event|gamemaster|moderation|resulting|slip)-[0-9a-f]{40}"
)
UPLOAD_LOCATION_PATH_RE = re.compile(
    rf"/v2/{re.escape(REPOSITORY)}/blobs/uploads?/"
    r"[A-Za-z0-9][A-Za-z0-9._~-]{15,255}"
)


def die(message):
    raise SystemExit(message)


def normalize_member_name(name):
    while name.startswith("./"):
        name = name[2:]
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts:
        die("OCI archive contains an unsafe member path")
    return str(path)


def digest_hex(digest):
    if not DIGEST_RE.fullmatch(digest):
        die("OCI archive descriptor has an invalid digest")
    return digest.split(":", 1)[1]


def descriptor_shape(descriptor):
    if not isinstance(descriptor, dict):
        die("OCI archive descriptor is not an object")
    digest = descriptor.get("digest")
    size = descriptor.get("size")
    media_type = descriptor.get("mediaType")
    if (
        not isinstance(digest, str)
        or not DIGEST_RE.fullmatch(digest)
        or not isinstance(size, int)
        or size < 0
        or not isinstance(media_type, str)
        or not media_type
        or descriptor.get("urls")
    ):
        die("OCI archive descriptor is malformed or externally referenced")
    return digest, size, media_type


class Archive:
    def __init__(self, path):
        self.path = path
        self.tar = tarfile.open(path, mode="r:*")
        self.members = {}
        try:
            total_size = 0
            for member in self.tar.getmembers():
                name = normalize_member_name(member.name)
                if name in self.members:
                    die("OCI archive contains duplicate member paths")
                if member.isdir():
                    continue
                if not member.isfile():
                    die("OCI archive contains a non-regular member")
                if not (
                    name in {"index.json", "manifest.json", "oci-layout"}
                    or re.fullmatch(r"blobs/sha256/[0-9a-f]{64}", name)
                ):
                    die("OCI archive contains an unexpected regular file")
                total_size += member.size
                if member.size > 1_500_000_000 or total_size > 4_000_000_000:
                    die("OCI archive exceeds the bounded recovery size")
                self.members[name] = member
        except BaseException:
            self.tar.close()
            raise

    def close(self):
        self.tar.close()

    def read(self, name):
        member = self.members.get(name)
        if member is None:
            die(f"OCI archive is missing {name}")
        stream = self.tar.extractfile(member)
        if stream is None:
            die(f"OCI archive member cannot be read: {name}")
        data = stream.read()
        if len(data) != member.size:
            die(f"OCI archive member is truncated: {name}")
        return data

    def read_blob(self, digest, expected_size=None):
        data = self.read(f"blobs/sha256/{digest_hex(digest)}")
        if hashlib.sha256(data).hexdigest() != digest_hex(digest):
            die("OCI archive blob digest does not match its content")
        if expected_size is not None and len(data) != expected_size:
            die("OCI archive blob size does not match its descriptor")
        return data

    def has_blob(self, digest):
        return f"blobs/sha256/{digest_hex(digest)}" in self.members


def parse_json(data, label):
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        die(f"{label} is not valid JSON: {error}")
    if not isinstance(value, dict):
        die(f"{label} is not a JSON object")
    return value


def expected_manifest_reachable(archive, expected_digest):
    index = parse_json(archive.read("index.json"), "OCI archive index")
    if index.get("schemaVersion") != 2 or not isinstance(index.get("manifests"), list):
        die("OCI archive index has an invalid schema")
    pending = list(index["manifests"])
    seen = set()
    while pending:
        descriptor = pending.pop()
        digest, size, media_type = descriptor_shape(descriptor)
        if digest in seen or not archive.has_blob(digest):
            continue
        seen.add(digest)
        data = archive.read_blob(digest, size)
        if digest == expected_digest and media_type in MANIFEST_MEDIA_TYPES:
            return True
        if media_type in INDEX_MEDIA_TYPES:
            nested = parse_json(data, "OCI archive nested index")
            if nested.get("schemaVersion") != 2 or not isinstance(
                nested.get("manifests"), list
            ):
                die("OCI archive nested index has an invalid schema")
            pending.extend(nested["manifests"])
    return False


def http_request(method, url, headers=None, data=None, allowed=(200,)):
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": "betstan-ghcr-cache-recovery/1",
            **(headers or {}),
        },
        method=method,
    )
    try:
        response = urllib.request.urlopen(
            request, timeout=120, context=ssl.create_default_context()
        )
    except urllib.error.HTTPError as error:
        if error.code in allowed:
            return error
        die(f"GHCR request failed: {method} {urllib.parse.urlsplit(url).path} HTTP {error.code}")
    except urllib.error.URLError as error:
        die(f"GHCR request failed before response: {error.reason}")
    if response.status not in allowed:
        die(
            f"GHCR request returned an unexpected status: "
            f"{method} {urllib.parse.urlsplit(url).path} HTTP {response.status}"
        )
    return response


def obtain_bearer_token(actor, package_token):
    query = urllib.parse.urlencode(
        {
            "service": REGISTRY,
            "scope": f"repository:{REPOSITORY}:pull,push",
        }
    )
    basic = base64.b64encode(f"{actor}:{package_token}".encode()).decode()
    response = http_request(
        "GET",
        f"https://{REGISTRY}/token?{query}",
        headers={"Authorization": f"Basic {basic}"},
    )
    payload = parse_json(response.read(), "GHCR token response")
    bearer = payload.get("token") or payload.get("access_token")
    if not isinstance(bearer, str) or not bearer:
        die("GHCR token response did not contain a bearer token")
    return bearer


def validate_upload_location(location):
    url = urllib.parse.urljoin(f"https://{REGISTRY}", location)
    parsed = urllib.parse.urlsplit(url)
    try:
        port = parsed.port
    except ValueError:
        die("GHCR returned an untrusted blob-upload location")
    if (
        parsed.scheme != "https"
        or parsed.hostname != REGISTRY
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        die("GHCR returned an untrusted blob-upload location")
    if not UPLOAD_LOCATION_PATH_RE.fullmatch(parsed.path):
        die("GHCR returned a blob-upload location outside the target repository")
    if any(
        key.lower() == "digest"
        for key, _value in urllib.parse.parse_qsl(
            parsed.query, keep_blank_values=True
        )
    ):
        die("GHCR blob-upload location already contains a digest")
    return url


def upload_blob(digest, data, bearer):
    base = f"https://{REGISTRY}/v2/{REPOSITORY}"
    authorization = {"Authorization": f"Bearer {bearer}"}
    response = http_request(
        "HEAD",
        f"{base}/blobs/{digest}",
        headers=authorization,
        allowed=(200, 404),
    )
    if response.status == 200:
        return
    response = http_request(
        "POST",
        f"{base}/blobs/uploads/",
        headers={**authorization, "Content-Length": "0"},
        data=b"",
        allowed=(202,),
    )
    location = response.headers.get("Location")
    if not location:
        die("GHCR blob upload did not return a location")
    upload_url = validate_upload_location(location)
    parsed = urllib.parse.urlsplit(upload_url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("digest", digest))
    upload_url = urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), "")
    )
    response = http_request(
        "PUT",
        upload_url,
        headers={
            **authorization,
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(data)),
        },
        data=data,
        allowed=(201,),
    )
    observed = response.headers.get("Docker-Content-Digest")
    if observed and observed != digest:
        die("GHCR stored a blob under an unexpected digest")


def publish_manifest(tag, digest, media_type, data, bearer):
    authorization = {"Authorization": f"Bearer {bearer}"}
    manifest_url = f"https://{REGISTRY}/v2/{REPOSITORY}/manifests/{tag}"
    response = http_request(
        "PUT",
        manifest_url,
        headers={
            **authorization,
            "Content-Type": media_type,
            "Content-Length": str(len(data)),
        },
        data=data,
        allowed=(201,),
    )
    observed = response.headers.get("Docker-Content-Digest")
    if observed and observed != digest:
        die("GHCR stored the recovered manifest under an unexpected digest")
    response = http_request(
        "HEAD",
        manifest_url,
        headers={**authorization, "Accept": media_type},
        allowed=(200,),
    )
    if response.headers.get("Docker-Content-Digest") != digest:
        die("GHCR exact tag does not resolve to the recovered manifest digest")


def main():
    archive_path = Path(os.environ.get("OCI_ARCHIVE_FILE", ""))
    tag = os.environ.get("GHCR_TARGET_TAG", "")
    expected_digest = os.environ.get("EXPECTED_PLATFORM_DIGEST", "")
    actor = os.environ.get("GHCR_ACTOR", "")
    package_token = os.environ.get("GHCR_TOKEN", "")
    if (
        not archive_path.is_file()
        or archive_path.is_symlink()
        or not TAG_RE.fullmatch(tag)
        or not DIGEST_RE.fullmatch(expected_digest)
        or not re.fullmatch(r"[A-Za-z0-9-]+", actor)
        or not package_token
    ):
        die("OCI archive publication inputs are incomplete or invalid")

    archive = Archive(archive_path)
    try:
        if not expected_manifest_reachable(archive, expected_digest):
            die("trusted ARM64 manifest is not reachable from the OCI archive index")
        manifest_data = archive.read_blob(expected_digest)
        manifest = parse_json(manifest_data, "trusted ARM64 manifest")
        media_type = manifest.get("mediaType")
        if (
            manifest.get("schemaVersion") != 2
            or media_type not in MANIFEST_MEDIA_TYPES
            or not isinstance(manifest.get("layers"), list)
        ):
            die("trusted ARM64 manifest has an unsupported schema")
        config_digest, config_size, _ = descriptor_shape(manifest.get("config"))
        config_data = archive.read_blob(config_digest, config_size)
        config = parse_json(config_data, "trusted ARM64 image config")
        if config.get("os") != "linux" or config.get("architecture") != "arm64":
            die("trusted platform manifest is not linux/arm64")
        blobs = [(config_digest, config_data)]
        for layer in manifest["layers"]:
            layer_digest, layer_size, _ = descriptor_shape(layer)
            blobs.append((layer_digest, archive.read_blob(layer_digest, layer_size)))

        bearer = obtain_bearer_token(actor, package_token)
        for blob_digest, blob_data in blobs:
            upload_blob(blob_digest, blob_data, bearer)
        publish_manifest(tag, expected_digest, media_type, manifest_data, bearer)
    finally:
        archive.close()

    print(
        f"ghcr_oci_archive_push=PASS tag={tag} manifest_digest={expected_digest}",
        flush=True,
    )


if __name__ == "__main__":
    main()
