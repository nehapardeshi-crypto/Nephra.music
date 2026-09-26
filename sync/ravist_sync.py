import json
import os
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import boto3

ARTIST_URL = os.environ.get("ARTIST_URL", "https://ravist.in/artist/nephra")
BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("PREFIX", "shows/")
PUBLIC_BASE = f"https://{BUCKET}.s3.{os.environ.get('AWS_REGION', 'ap-south-1')}.amazonaws.com/"
UA = {"User-Agent": "Mozilla/5.0 (compatible; nephra-site-sync/1.0; +https://nephra.music)"}

s3 = boto3.client("s3")


def get(url, binary=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
        body = r.read()
        return (body, r.headers.get("Content-Type", "")) if binary else body.decode("utf-8", "replace")


def event_ids(html):
    seen, out = set(), []
    for city, eid in re.findall(r'href="/([a-z-]+)/event/([a-f0-9]{24})"', html):
        if eid not in seen:
            seen.add(eid)
            out.append((city, eid))
    return out


def json_ld_event(html):
    for block in re.findall(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            d = json.loads(block)
        except ValueError:
            continue
        if "Event" in str(d.get("@type")):
            return d
    return None


MEDIA_RE = re.compile(r'https://ravist\.s3\.[a-z0-9-]+\.amazonaws\.com/posters/[^"\\\s)]+\.(?:jpe?g|png|webp|mp4|webm)')
EXT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
             ".mp4": "video/mp4", ".webm": "video/webm"}


def mirror(key_base, src, default_ext):
    ext = os.path.splitext(src.split("?")[0])[1].lower()
    ext = ext if ext in EXT_TYPES else default_ext
    key = f"{PREFIX}posters/{key_base}{ext}"
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
        return PUBLIC_BASE + key
    except s3.exceptions.ClientError:
        pass
    body, ctype = get(src, binary=True)
    s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=EXT_TYPES.get(ext) or ctype,
                  CacheControl="public, max-age=31536000, immutable")
    return PUBLIC_BASE + key


def pick_poster(html, exclude):
    # The event's own poster is linked repeatedly; the artist photo is also on the artist page.
    counts = {}
    for u in MEDIA_RE.findall(html):
        if u not in exclude:
            counts[u] = counts.get(u, 0) + 1
    return max(counts, key=counts.get) if counts else None


def build_event(url, eid, html, exclude):
    ld = json_ld_event(html)
    if not ld or not ld.get("startDate"):
        return None
    src = pick_poster(html, exclude)
    card = f"{url}/opengraph-image"
    poster = video = None
    try:
        if src and src.endswith((".mp4", ".webm")):
            video = mirror(eid, src, ".mp4")
            poster = mirror(f"{eid}-still", card, ".png")
        else:
            poster = mirror(eid, src or card, ".png")
    except Exception as e:
        print(f"poster failed for {eid}: {e}")
    loc = ld.get("location") or {}
    addr = loc.get("address") or {}
    return {
        "id": eid,
        "title": ld.get("name", "").strip(),
        "start": ld["startDate"],
        "end": ld.get("endDate"),
        "venue": (loc.get("name") or "").strip(),
        "city": addr.get("addressRegion") or addr.get("addressLocality") or "",
        "status": (ld.get("eventStatus") or "").rsplit("/", 1)[-1],
        "performers": [p.get("name") for p in ld.get("performer") or [] if p.get("name")],
        "url": url,
        "poster": poster,
        "posterVideo": video,
    }


def handler(event=None, context=None):
    artist_html = get(ARTIST_URL)
    ids = event_ids(artist_html)
    if not ids:
        raise RuntimeError("No events found on artist page; keeping previous shows.json")
    urls = [(f"https://ravist.in/{city}/event/{eid}", eid) for city, eid in ids]
    with ThreadPoolExecutor(max_workers=4) as pool:
        pages = list(pool.map(lambda u: get(u[0]), urls))
    # Media shared by several event pages (e.g. the artist photo) is not an event poster.
    seen_on = {}
    for html in pages:
        for u in set(MEDIA_RE.findall(html)):
            seen_on[u] = seen_on.get(u, 0) + 1
    exclude = {u for u, n in seen_on.items() if n > 1}
    with ThreadPoolExecutor(max_workers=4) as pool:
        events = [e for e in pool.map(lambda p: build_event(p[0][0], p[0][1], p[1], exclude), zip(urls, pages)) if e]
    if not events:
        raise RuntimeError("No event data parsed; keeping previous shows.json")
    events.sort(key=lambda e: e["start"], reverse=True)
    doc = {"source": ARTIST_URL, "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "events": events}
    s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}shows.json", Body=json.dumps(doc, ensure_ascii=False).encode(),
                  ContentType="application/json", CacheControl="public, max-age=900")
    print(f"wrote {len(events)} events")
    return {"count": len(events)}
