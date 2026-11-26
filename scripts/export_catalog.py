"""Build the public catalog from a locally held ShowJCR review export."""
import csv
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

PUBLIC_REGION_EXCEPTIONS = {
    "International Computing and Combinatorics Conference": "http://cocoon-conference.org/",
    "Computational Visual Media Conference": "https://cg.cs.tsinghua.edu.cn/conf/homepage.htm",
    "International Conference on Intelligent Computing": "http://www.ic-icc.cn/2025/index.htm",
    "Theoretical Aspects of Software Engineering Conference": "https://tase2026.github.io/",
}
RANKS = {"A", "B", "C", "-"}
OUTPUT = Path(__file__).resolve().parent.parent / "public" / "catalog.json"


def new_entry(row):
    name = row["显示名称"].strip()
    kind = {"会议": "conference", "期刊": "journal"}[row["类型"]]
    ccf = row["CCF"]
    cacr = row["CACR"]
    assert ccf in RANKS and cacr in RANKS and (ccf, cacr) != ("-", "-"), name
    details = row["目录详情"]
    international = sorted(set(re.findall(r"CCF 国际 2026 · ([ABC])类", details)))
    chinese = sorted(set(re.findall(r"CCF-T 2025 · (T[123])", details)))
    assert (ccf != "-") == bool(international or chinese), name
    aliases = [x.strip() for x in row["别名及简称"].split(" / ")
               if x.strip() and len(x.strip()) <= 140 and not x.startswith("原刊名信息为：")]
    dblp = sorted(set(x.lower() for x in re.findall(r"/db/conf/([^/?#\s]+)", details))) if kind == "conference" else []
    basis = row["地区依据"]
    region = {"中国": "CN", "外国": "foreign", "待核实": "unknown"}[row["地区"]]
    links = re.findall(r"https?://[^\s<>]+", basis)
    if "按用户确认" in basis:
        source = PUBLIC_REGION_EXCEPTIONS.get(name)
        if source:
            links = [source]
        else:
            region, links = "unknown", []
    elif not links and not basis.startswith("国内刊号"):
        region = "unknown"
    identifier = hashlib.sha256(f"{kind}:{unicodedata.normalize('NFC', name)}".encode()).hexdigest()[:16]
    entry = {"id": identifier, "name": name, "kind": kind, "aliases": aliases,
             "ccf": None if ccf == "-" else ccf, "cacr": None if cacr == "-" else cacr,
             "international": international, "chinese": chinese, "region": region}
    if links and region != "unknown":
        entry["regionSources"] = links[:3]
    if dblp:
        entry["dblp"] = dblp
    return entry


def main():
    with Path(sys.argv[1]).open(encoding="utf-8-sig", newline="") as source:
        entries = [new_entry(row) for row in csv.DictReader(source, delimiter="\t")]
    assert len({e["id"] for e in entries}) == len(entries)
    assert Counter(e["kind"] for e in entries) == {"conference": 396, "journal": 364}
    OUTPUT.write_text("[\n" + ",\n".join(json.dumps(e, ensure_ascii=False, separators=(",", ":"))
                                        for e in entries) + "\n]\n", encoding="utf-8")
    print(f"Public catalog: {len(entries)} records, regions {dict(Counter(e['region'] for e in entries))}")


if __name__ == "__main__":
    main()
