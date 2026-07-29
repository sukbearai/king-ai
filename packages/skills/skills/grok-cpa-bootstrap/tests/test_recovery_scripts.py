import importlib.util
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    path = ROOT / "scripts" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit_stack = load_script("audit_stack")
retry_cpa_auth = load_script("retry_cpa_auth")


class RetryCpaAuthTests(unittest.TestCase):
    def test_access_denied_is_not_retryable(self):
        category, retryable = retry_cpa_auth.classify_auth_error(
            "device auth token error: invalid_grant: Access denied"
        )
        self.assertEqual("access_denied", category)
        self.assertFalse(retryable)

    def test_unverified_identity_is_distinct_and_not_retryable(self):
        category, retryable = retry_cpa_auth.classify_auth_error(
            "auth failed: consent identity unavailable"
        )
        self.assertEqual("identity_unverified", category)
        self.assertFalse(retryable)

    def test_only_transient_categories_are_retryable(self):
        self.assertEqual(
            ("rate_limited", True),
            retry_cpa_auth.classify_auth_error("device code request failed HTTP 429: slow_down"),
        )
        self.assertEqual(
            ("network", True),
            retry_cpa_auth.classify_auth_error("connection reset by peer"),
        )
        self.assertEqual(
            ("upstream_server", True),
            retry_cpa_auth.classify_auth_error("token endpoint HTTP 503: service unavailable"),
        )
        self.assertEqual(("unknown", False), retry_cpa_auth.classify_auth_error("unexpected response"))

    def test_access_denied_stops_after_one_attempt_without_identity_output(self):
        calls = []

        def export_account(**kwargs):
            calls.append(kwargs)
            kwargs["log_callback"](
                "device user_code=ABCD-EFGH proxy=http://user:pass@127.0.0.1:1082"
            )
            return {"ok": False, "error": "invalid_grant: Access denied"}

        with tempfile.TemporaryDirectory() as directory:
            output = StringIO()
            with redirect_stdout(output):
                category = retry_cpa_auth.recover_account(
                    export_account,
                    "target@example.com",
                    "secret-password",
                    "secret-sso",
                    {},
                    Path(directory) / "xai-target@example.com.json",
                    1,
                    1,
                    3,
                    0,
                    sleep=lambda _: None,
                )

        self.assertEqual("access_denied", category)
        self.assertEqual(1, len(calls))
        self.assertNotIn("target@example.com", output.getvalue())
        self.assertNotIn("ABCD-EFGH", output.getvalue())
        self.assertNotIn("user:pass", output.getvalue())

    def test_transient_failure_retries_to_attempt_limit(self):
        calls = []

        def export_account(**kwargs):
            calls.append(kwargs)
            return {"ok": False, "error": "connection reset by peer"}

        with tempfile.TemporaryDirectory() as directory:
            with redirect_stdout(StringIO()):
                category = retry_cpa_auth.recover_account(
                    export_account,
                    "target@example.com",
                    "secret-password",
                    "secret-sso",
                    {},
                    Path(directory) / "xai-target@example.com.json",
                    1,
                    1,
                    3,
                    0,
                    sleep=lambda _: None,
                )

        self.assertEqual("network", category)
        self.assertEqual(3, len(calls))

    def test_progress_events_do_not_include_sensitive_values(self):
        event = retry_cpa_auth.safe_progress_event(
            "device user_code=ABCD-EFGH expires_in=1800 proxy=http://user:pass@127.0.0.1:1082"
        )
        self.assertEqual("device_code_created", event)
        self.assertNotIn("ABCD", event)
        self.assertNotIn("user:pass", event)

    def test_proxy_override_is_in_memory_and_source_is_sanitized(self):
        config = {"cpa_proxy": "", "proxy": ""}
        environ = {"CPA_OIDC_PROXY": "http://user:pass@127.0.0.1:1082"}
        updated = retry_cpa_auth.apply_proxy_override(config, environ, "CPA_OIDC_PROXY")
        self.assertEqual("", config["cpa_proxy"])
        self.assertEqual(environ["CPA_OIDC_PROXY"], updated["cpa_proxy"])
        self.assertEqual(
            "explicit_env",
            retry_cpa_auth.proxy_source(config, environ, "CPA_OIDC_PROXY"),
        )

    def test_expected_account_count_keeps_legacy_alias(self):
        common = ["--repo", "/tmp/repo", "--accounts", "/tmp/accounts.txt"]
        current = retry_cpa_auth.parse_args(common + ["--expected-account-count", "2"])
        legacy = retry_cpa_auth.parse_args(common + ["--expected-count", "3"])
        self.assertEqual(2, current.expected_account_count)
        self.assertEqual(3, legacy.expected_account_count)


class AuditStackTests(unittest.TestCase):
    def test_total_auth_count_name_keeps_legacy_alias(self):
        current = audit_stack.parse_args(["--expected-total-auth-count", "1279"])
        legacy = audit_stack.parse_args(["--expected-auth-count", "1278"])
        self.assertEqual(1279, current.expected_total_auth_count)
        self.assertEqual(1278, legacy.expected_total_auth_count)


if __name__ == "__main__":
    unittest.main()
