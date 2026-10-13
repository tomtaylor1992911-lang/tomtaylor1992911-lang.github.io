"""Offline checks for the ORCID synchronization and last-good-data contract."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

MODULE = Path(__file__).resolve().parents[1] / "sync_orcid.py"
SPEC = importlib.util.spec_from_file_location("sync_orcid", MODULE)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)
ORCID = "0000-0003-0360-5526"


def work(code=1, title="Sample research paper", year="2025", doi="10.1234/Example", kind="journal-article"):
    return {
        "put-code": code,
        "display-index": "0",
        "visibility": "public",
        "title": {"title": {"value": title}},
        "publication-date": {"year": {"value": year}},
        "journal-title": {"value": "Example Journal"},
        "type": kind,
        "external-ids": {"external-id": [{
            "external-id-type": "doi", "external-id-value": doi,
            "external-id-relationship": "self",
        }]} if doi else {},
    }


def summary_payload(*works):
    return {"group": [{"work-summary": [item]} for item in works]}


class NormalizationTests(unittest.TestCase):
    def test_doi_variants_and_invalid_values(self):
        for value in (" DOI: 10.1234/EXAMPLE ", "https://doi.org/10.1234/EXAMPLE",
                      "http://dx.doi.org/10.1234/EXAMPLE?tracking=1#part"):
            self.assertEqual(sync.normalize_doi(value), "10.1234/example")
        self.assertEqual(sync.normalize_doi("https://example.org/10.1234/example"), "")
        self.assertEqual(sync.normalize_doi("not a DOI"), "")

    def test_unicode_title_and_safe_links(self):
        self.assertEqual(sync.normalize_title("Photo–Gated\n Corona &amp; Flow"),
                         sync.normalize_title("photo gated corona & flow"))
        for link in ("javascript:alert(1)", "data:text/html,x", "//example.org/x",
                     "https://user:password@example.org/x", "https://example.org:bad/x"):
            self.assertEqual(sync.safe_url(link), "")
        self.assertEqual(sync.safe_url("https://example.org/paper"), "https://example.org/paper")

    def test_orcid_checksum(self):
        self.assertEqual(sync.validate_orcid(ORCID), ORCID)
        with self.assertRaises(sync.SyncError):
            sync.validate_orcid("0000-0003-0360-5527")

    def test_part_of_doi_is_not_publication_identity(self):
        item = work()
        item["external-ids"]["external-id"][0]["external-id-relationship"] = "part-of"
        self.assertEqual(sync.doi_for_work(item), "")

    def test_invalid_dates_and_partial_date(self):
        item = work()
        item["publication-date"].update({"month": {"value": "2"}, "day": {"value": "30"}})
        self.assertEqual(sync.publication_date(item), (2025, "2025-02"))


class PublicationTests(unittest.TestCase):
    def test_preferred_summary_uses_display_index(self):
        first, preferred = work(1), work(2, title="Preferred title")
        first["last-modified-date"] = {"value": 999}
        preferred["display-index"] = "1"
        preferred["last-modified-date"] = {"value": 1}
        result, _ = sync.preferred_summaries({"group": [{"work-summary": [first, preferred]}]})
        self.assertEqual(result[0]["put-code"], 2)

    def test_deduplication_merges_metadata_and_missing_doi(self):
        first = sync.extract_publication(work(3, title="Paper one", doi="https://doi.org/10.1234/A"))
        second = sync.extract_publication(work(4, title="Paper one", doi="10.1234/a"))
        second["authors"] = "A. Researcher"
        no_doi = sync.extract_publication(work(5, title="Paper–one", doi=""))
        no_doi["journal"] = ""
        second_doi = sync.extract_publication(work(6, title="Paper one", doi="10.1234/b"))
        result = sync.deduplicate([no_doi, second, first, second_doi])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["authors"], "A. Researcher")
        self.assertEqual(sync.deduplicate(list(reversed([no_doi, second, first, second_doi]))), result)

    def test_missing_detail_fields_preserve_existing_metadata(self):
        item = work()
        item.pop("journal-title")
        old = {"authors": "A. Writer, B. Writer", "journal": "Last Good Journal"}
        result = sync.extract_publication(item, {"contributors": None}, old)
        self.assertEqual(result["authors"], old["authors"])
        self.assertEqual(result["journal"], old["journal"])

    def test_summary_title_keeps_clean_characters(self):
        item = work(title="Corona–driven droplets")
        detail = copy.deepcopy(item)
        detail["title"]["title"]["value"] = "Corona\ufffdCdriven droplets"
        detail["contributors"] = {"contributor": [
            {"credit-name": {"value": "Qiang Tang"}, "contributor-attributes": {"contributor-role": "author"}},
            {"credit-name": {"value": "An Editor"}, "contributor-attributes": {"contributor-role": "editor"}},
        ]}
        result = sync.extract_publication(item, detail)
        self.assertEqual(result["title"], "Corona–driven droplets")
        self.assertEqual(result["authors"], "Qiang Tang")


class SafeSynchronizationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "orcid.json"
        self.old = {"orcid": ORCID, "last_sync": "2026-01-01T00:00:00Z",
                    "publications": [sync.extract_publication(work())]}
        self.old["publications"][0]["authors"] = "Author Before Outage"
        self.path.write_text(json.dumps(self.old), encoding="utf-8")
        self.before = self.path.read_bytes()

    def tearDown(self):
        self.directory.cleanup()

    def test_failed_summary_does_not_overwrite_last_good_data(self):
        def failure(url):
            raise sync.SyncError("Network unavailable")
        with self.assertRaises(sync.SyncError):
            sync.sync(ORCID, self.path, failure)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_malformed_and_empty_responses_do_not_overwrite(self):
        for malformed in ({}, {"group": []}, {"group": [None]}, {"group": [{"work-summary": []}]},
                          {"group": [{"work-summary": [{"title": "wrong shape"}]}]}):
            with self.subTest(payload=malformed):
                with self.assertRaises(sync.SyncError):
                    sync.sync(ORCID, self.path, lambda url: malformed)
                self.assertEqual(self.path.read_bytes(), self.before)

    def test_detail_outage_preserves_metadata_and_records_warning(self):
        item = work()
        item.pop("journal-title")
        def fetch(url):
            if url.endswith("/works"):
                return summary_payload(item)
            raise sync.SyncError("Bulk detail outage")
        result = sync.sync(ORCID, self.path, fetch)
        self.assertEqual(result["publications"][0]["authors"], "Author Before Outage")
        self.assertEqual(result["publications"][0]["journal"], "Example Journal")
        self.assertTrue(result["sync_info"]["warnings"])
        self.assertNotEqual(result["last_sync"], self.old["last_sync"])

    def test_duplicate_summary_and_patent_counts(self):
        items = [work(1), work(2), work(3, title="Patent", kind="patent", doi="")]
        def fetch(url):
            if url.endswith("/works"):
                return summary_payload(*items)
            return {"bulk": [{"work": item} for item in items[:2]]}
        result = sync.sync(ORCID, self.path, fetch)
        self.assertEqual(result["work_count"], 1)
        self.assertEqual(result["sync_info"]["excluded_patents"], 1)
        self.assertEqual(result["sync_info"]["duplicates_removed"], 1)
        self.assertEqual(result["sync_info"]["types"], {"journal-article": 1})

    def test_retryable_http_error_is_retried_and_nonretryable_is_not(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                return b'{"group": []}'
        outage = HTTPError("https://example.org", 503, "Unavailable", {}, None)
        with patch.object(sync, "urlopen", side_effect=[outage, Response()]) as opener:
            with patch.object(sync.time, "sleep"):
                self.assertEqual(sync.fetch_json("https://example.org"), {"group": []})
            self.assertEqual(opener.call_count, 2)
        forbidden = HTTPError("https://example.org", 403, "Forbidden", {}, None)
        with patch.object(sync, "urlopen", side_effect=forbidden) as opener:
            with self.assertRaises(sync.SyncError):
                sync.fetch_json("https://example.org")
            self.assertEqual(opener.call_count, 1)

    def test_persistent_outage_has_bounded_attempts_and_waits(self):
        outage = HTTPError("https://example.org", 429, "Too many requests",
                           {"Retry-After": "3600"}, None)
        # A large Retry-After value cannot turn a scheduled sync into an
        # unbounded wait. The same monotonic clock is used for the total budget.
        with patch.object(sync, "urlopen", side_effect=outage) as opener:
            with patch.object(sync.time, "sleep") as sleeper:
                with self.assertRaises(sync.SyncError):
                    sync.fetch_json("https://example.org")
            self.assertEqual(opener.call_count, sync.MAX_ATTEMPTS)
            self.assertLessEqual(sleeper.call_count, sync.MAX_ATTEMPTS - 1)
            self.assertTrue(all(call.args[0] <= 30 for call in sleeper.call_args_list))

    def test_bulk_details_are_split_at_one_hundred(self):
        items = [work(code=code, title=f"Paper {code}", doi=f"10.1234/{code}")
                 for code in range(1, 102)]
        requests = []
        def fetch(url):
            codes = url.rsplit("/", 1)[-1].split(",")
            requests.append(codes)
            return {"bulk": [{"work": items[int(code) - 1]} for code in codes]}
        details, warnings = sync.fetch_details(ORCID, items, fetch)
        self.assertEqual([len(codes) for codes in requests], [100, 1])
        self.assertEqual(len(details), 101)
        self.assertEqual(warnings, [])


if __name__ == "__main__":
    unittest.main()
