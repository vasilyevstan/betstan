#!/usr/bin/env python3

import unittest

from deep_client import validate_endpoint


class DeepClientTest(unittest.TestCase):
    def test_accepts_exact_diagnostic_origin(self):
        self.assertEqual(
            "https://203.0.113.10.nip.io",
            validate_endpoint("https://203.0.113.10.nip.io/"),
        )

    def test_rejects_non_diagnostic_or_credentialed_url(self):
        for value in (
            "http://203.0.113.10.nip.io",
            "https://betstan.xyz",
            "https://user:password@203.0.113.10.nip.io",
            "https://203.0.113.10.nip.io/path",
        ):
            with self.subTest(value=value), self.assertRaises(Exception):
                validate_endpoint(value)


if __name__ == "__main__":
    unittest.main()
