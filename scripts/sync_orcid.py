#!/usr/bin/env python3
"""Read ORCID public works into data/orcid.json; never write to ORCID.

Only the Python standard library is required. Public works retain their ORCID
type; patents are excluded from the publication list. The preferred summary in
each ORCID group is selected by display-index, then modification date. Metadata
is filled from the bulk /works/{put-codes} endpoint (at most 100 per request).
Missing detail metadata falls back to the last good local record. A failed,
malformed, or unexpectedly empty summary response leaves the file untouched.

Public API documentation:
https://info.orcid.org/documentation/api-tutorials/api-tutorial-read-data-on-a-record/
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import html
import json
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
API_ROOT = "https://pub.orcid.org/v3.0"
REQUEST_BUDGET = 60.0
MAX_ATTEMPTS = 4


class SyncError(RuntimeError):
    """The remote data cannot safely replace the last good local data."""


def text(value):
    if isinstance(value, dict):
        value = value.get("value")
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        return ""
    return " ".join(html.unescape(str(value)).split())


def normalize_title(value):
    value = unicodedata.normalize("NFKC", text(value)).casefold()
    return "".join(character for character in value if character.isalnum())


def normalize_doi(value):
    value = text(value)
    value = re.sub(r"^doi\s*:\s*", "", value, flags=re.IGNORECASE)
    if re.match(r"^https?://(?:dx\.)?doi\.org/", value, re.IGNORECASE):
        value = unquote(urlsplit(value).path.lstrip("/"))
    value = value.strip().casefold()
    return value if re.fullmatch(r"10\.\d{4,9}/\S+", value) else ""


def safe_url(value):
    value = text(value)
    if not value or any(character.isspace() for character in value):
        return ""
    try:
        parsed = urlsplit(value)
        if (parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password):
            return ""
        # Accessing port rejects malformed authorities such as example.org:abc.
        parsed.port
    except ValueError:
        return ""
    return value


def validate_orcid(value):
    value = text(value)
    if not re.fullmatch(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", value):
        raise SyncError("An ORCID iD in the form 0000-0000-0000-000X is required")
    digits = value.replace("-", "")
    total = 0
    for digit in digits[:-1]:
        total = (total + int(digit)) * 2
    check = (12 - total % 11) % 11
    if digits[-1] != ("X" if check == 10 else str(check)):
        raise SyncError("The ORCID iD checksum is invalid")
    return value


def retry_after_seconds(header):
    if not header:
        return None
    try:
        delay = float(header)
    except (ValueError, TypeError):
        try:
            date = parsedate_to_datetime(header)
            delay = (date - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return None
    return min(30.0, max(0.0, delay))


def fetch_json(url):
    """Bound each request's retries and waiting to a 60-second budget."""
    deadline = time.monotonic() + REQUEST_BUDGET
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        delay = min(2 ** attempt, 8)
        request = Request(url, headers={
            "Accept": "application/json",
            "User-Agent": "AcademicHomepageORCIDSync/1.0 (read-only public works)",
        }, method="GET")
        try:
            with urlopen(request, timeout=min(20.0, remaining)) as response:
                payload = json.load(response)
            if not isinstance(payload, dict):
                raise SyncError("ORCID returned a non-object JSON response")
            return payload
        except HTTPError as error:
            last_error = error
            if error.code not in {408, 429, 500, 502, 503, 504}:
                raise SyncError(f"ORCID HTTP {error.code} while reading public works") from error
            delay = retry_after_seconds(error.headers.get("Retry-After")) or delay
        except (URLError, TimeoutError, socket.timeout, json.JSONDecodeError) as error:
            last_error = error
        if attempt + 1 < MAX_ATTEMPTS:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(delay, remaining))
    raise SyncError(f"ORCID request failed after bounded retries: {last_error}")


def _number(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def preferred_summaries(payload):
    groups = payload.get("group")
    if not isinstance(groups, list) or not groups:
        raise SyncError("ORCID returned no valid public work groups; keeping the last good file")
    selected = []
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("work-summary"), list):
            raise SyncError("Malformed ORCID work group; keeping the last good file")
        candidates = [item for item in group["work-summary"] if isinstance(item, dict)
                      and item.get("visibility", "public").lower() == "public"]
        if not candidates:
            raise SyncError("ORCID work group has no public summaries")
        summary = max(candidates, key=lambda item: (
            _number(item.get("display-index")),
            _number((item.get("last-modified-date") or {}).get("value")),
            -_number(item.get("put-code")),
        ))
        if _number(summary.get("put-code")) <= 0:
            raise SyncError("ORCID work summary has an invalid put-code")
        title = text((summary.get("title") or {}).get("title"))
        if not normalize_title(title):
            raise SyncError("ORCID work summary has no usable title")
        selected.append(summary)
    return selected, len(groups)


def doi_for_work(work):
    container = work.get("external-ids") or {}
    if not isinstance(container, dict):
        return ""
    identifiers = container.get("external-id", [])
    if not isinstance(identifiers, list):
        return ""
    for identifier in identifiers:
        if not isinstance(identifier, dict) or text(identifier.get("external-id-type")).lower() != "doi":
            continue
        # A part-of DOI identifies the book/journal, not this work.
        if identifier.get("external-id-relationship") not in {None, "self", "version-of"}:
            continue
        for field in ("external-id-normalized", "external-id-value", "external-id-url"):
            doi = normalize_doi(identifier.get(field))
            if doi:
                return doi
    return ""


def publication_date(work):
    date = work.get("publication-date") or {}
    if not isinstance(date, dict):
        return None, ""
    year = _number(text(date.get("year")))
    if not 1000 <= year <= 9999:
        return None, ""
    result = str(year)
    month = _number(text(date.get("month")))
    day = _number(text(date.get("day")))
    if 1 <= month <= 12:
        result += f"-{month:02d}"
        if 1 <= day <= 31:
            try:
                datetime(year, month, day)
                result += f"-{day:02d}"
            except ValueError:
                pass
    return year, result


def contributors(work):
    container = work.get("contributors") or {}
    if not isinstance(container, dict):
        return ""
    items = container.get("contributor", [])
    if not isinstance(items, list):
        return ""
    names = []
    for item in items:
        if not isinstance(item, dict):
            continue
        attributes = item.get("contributor-attributes") or {}
        role = text(attributes.get("contributor-role")) if isinstance(attributes, dict) else ""
        if role and role != "author":
            continue
        name = text(item.get("credit-name"))
        if name and name not in names:
            names.append(name)
    return ", ".join(names)


def _identity(record):
    doi = normalize_doi(record.get("doi"))
    if doi:
        return "doi:" + doi
    return f"title:{normalize_title(record.get('title'))}:{record.get('year') or ''}"


def _old_record(summary, existing):
    doi = doi_for_work(summary)
    title = text((summary.get("title") or {}).get("title"))
    year, _ = publication_date(summary)
    for old in existing:
        if not isinstance(old, dict):
            continue
        if str(old.get("put_code")) == str(summary.get("put-code")):
            return old
        if doi and normalize_doi(old.get("doi")) == doi:
            return old
        if normalize_title(old.get("title")) == normalize_title(title) and old.get("year") == year:
            return old
    return {}


def extract_publication(summary, detail=None, existing=None):
    detail = detail or {}
    existing = existing or {}
    title = text((summary.get("title") or {}).get("title"))
    year, date = publication_date(summary)
    if not year:
        year, date = publication_date(detail)
    year = year or existing.get("year")
    date = date or text(existing.get("publication_date"))
    doi = doi_for_work(summary) or doi_for_work(detail) or normalize_doi(existing.get("doi"))
    authors = contributors(detail) or contributors(summary) or text(existing.get("authors"))
    journal = (text(summary.get("journal-title")) or text(detail.get("journal-title"))
               or text(existing.get("journal")))
    put_code = _number(summary.get("put-code"))
    url = ("https://doi.org/" + quote(doi, safe="/():;._-+") if doi else
           safe_url(summary.get("url")) or safe_url(detail.get("url"))
           or safe_url(existing.get("url")))
    identity = _identity({"doi": doi, "title": title, "year": year})
    return {
        "id": "orcid-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16],
        "title": title,
        "authors": authors,
        "journal": journal,
        "year": year,
        "publication_date": date,
        "doi": doi,
        "url": url,
        "type": text(summary.get("type")) or text(detail.get("type")) or "other",
        "put_code": put_code,
        "source": "orcid",
    }


def deduplicate(publications):
    records = []
    # Put-code is used only to break ties, never as the publication identity.
    # Process DOI-bearing records first so an incomplete title/year copy merges
    # into the stable DOI identity. Distinct DOIs are never merged by title alone.
    for publication in sorted(publications, key=lambda item: (not item["doi"], item["put_code"])):
        duplicate = next((record for record in records if
            (record["doi"] and record["doi"] == publication["doi"]) or
            ((not record["doi"] or not publication["doi"])
             and normalize_title(record["title"]) == normalize_title(publication["title"])
             and record["year"] == publication["year"])), None)
        if duplicate is None:
            records.append(publication.copy())
        else:
            for field in ("authors", "journal", "year", "publication_date", "doi", "url"):
                if not duplicate.get(field) and publication.get(field):
                    duplicate[field] = publication[field]
    return sorted(records, key=lambda item: (
        -(item.get("year") or 0), normalize_title(item["title"]), item["id"],
    ))


def read_existing(path, orcid):
    if not path.exists():
        return {}
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SyncError("Existing ORCID data is unreadable; refusing to overwrite it") from error
    if not isinstance(existing, dict) or not isinstance(existing.get("publications"), list):
        raise SyncError("Existing ORCID data has an unexpected structure")
    if existing.get("orcid") not in {None, orcid}:
        raise SyncError("Existing data belongs to another ORCID iD")
    return existing


def fetch_details(orcid, summaries, fetcher):
    details = {}
    warnings = []
    codes = sorted({str(_number(summary["put-code"])) for summary in summaries
                    if text(summary.get("type")) != "patent"}, key=int)
    for offset in range(0, len(codes), 100):
        chunk = codes[offset:offset + 100]
        try:
            payload = fetcher(f"{API_ROOT}/{orcid}/works/{','.join(chunk)}")
            bulk = payload.get("bulk")
            if not isinstance(bulk, list):
                raise SyncError("Unexpected ORCID bulk-detail structure")
            for entry in bulk:
                detail = entry.get("work") if isinstance(entry, dict) else None
                if isinstance(detail, dict) and str(detail.get("put-code")) in chunk:
                    details[str(detail["put-code"])] = detail
            missing = [code for code in chunk if code not in details]
            if missing:
                warnings.append(f"Metadata unavailable for {len(missing)} work(s); using summaries/previous values")
        except (SyncError, ValueError, OSError) as error:
            warnings.append(f"Detail request failed; using summaries/previous values: {error}")
    return details, warnings


def atomic_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sync(orcid, output, fetcher=fetch_json):
    orcid = validate_orcid(orcid)
    output = Path(output)
    existing = read_existing(output, orcid)
    try:
        summaries, group_count = preferred_summaries(fetcher(f"{API_ROOT}/{orcid}/works"))
    except (AttributeError, TypeError, KeyError) as error:
        raise SyncError("Malformed ORCID summary response; keeping the last good file") from error
    details, warnings = fetch_details(orcid, summaries, fetcher)
    publications = []
    patents = 0
    for summary in summaries:
        if text(summary.get("type")) == "patent":
            patents += 1
            continue
        previous = _old_record(summary, existing.get("publications", []))
        publications.append(extract_publication(summary, details.get(str(summary["put-code"])), previous))
    publications = deduplicate(publications)
    if not publications and existing.get("publications"):
        raise SyncError("The publication list would become empty; keeping the last good file")
    payload = {
        "orcid": orcid,
        "source_url": f"https://orcid.org/{orcid}",
        "last_sync": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "work_count": len(publications),
        "publications": publications,
        "sync_info": {
            "public_groups": group_count,
            "excluded_patents": patents,
            "duplicates_removed": len(summaries) - patents - len(publications),
            "types": dict(sorted(Counter(item["type"] for item in publications).items())),
            "details_received": len(details),
            "missing_authors": sum(not item["authors"] for item in publications),
            "missing_journal": sum(not item["journal"] for item in publications),
            "warnings": warnings,
        },
    }
    atomic_write(output, payload)
    for warning in warnings:
        print("Warning: " + warning, file=sys.stderr)
    print(f"Synced {len(publications)} public publications from {group_count} ORCID groups; "
          f"excluded {patents} patents. Types: {payload['sync_info']['types']}")
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orcid", help="Defaults to data/site.json profile.orcid")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "orcid.json")
    arguments = parser.parse_args()
    try:
        orcid = arguments.orcid
        if not orcid:
            configuration = json.loads((ROOT / "data" / "site.json").read_text(encoding="utf-8"))
            orcid = configuration["profile"]["orcid"]
        sync(orcid, arguments.output)
    except (SyncError, OSError, ValueError, KeyError) as error:
        print(f"Sync failed; the existing data file was preserved: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
